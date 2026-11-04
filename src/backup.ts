import { chmod, mkdtemp, readFile, rename, rm, statfs, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, SafeError, subprocessEnv } from './config.ts';
import type { Config } from './config.ts';
import { run } from './process.ts';
import type { Runner } from './process.ts';
import { convert, validateVault } from './convert.ts';
import { verifyHeader, verifyDatabase } from './verify.ts';
import type { Item, Download } from './model.ts';

interface Options {
  runner?: Runner;
  signal?: AbortSignal;
  tempRoot?: string;
  requireTmpfs?: boolean;
  progress?: (stage: string) => void;
}

export async function backup(config: Config, options: Options = {}): Promise<{ items: number; attachments: number }> {
  const runner = options.runner ?? run;
  const tempRoot = options.tempRoot ?? '/tmp';
  let workdir: string | undefined;
  let outputTemp: string | undefined;
  let stage = 'temporary storage';
  function progress(value: string): void {
    stage = value;
    options.signal?.throwIfAborted();
    options.progress?.(stage);
  }
  try {
    if (options.requireTmpfs !== false && (await statfs(tempRoot)).type !== 0x01021994) {
      throw new Error('Temporary directory must be tmpfs');
    }
    workdir = await mkdtemp(join(tempRoot, 'bw2kbdx-'));
    await chmod(workdir, 0o700);
    const baseEnv = subprocessEnv(workdir);
    const bwEnv = { ...baseEnv, BITWARDENCLI_APPDATA_DIR: join(workdir, 'bw'), BW_NOINTERACTION: 'true' };
    const bw = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => runner('bw', ['--nointeraction', ...args], {
      cwd: workdir!, env: { ...bwEnv, ...extraEnv }, signal: options.signal,
    });
    progress('server configuration');
    await bw(['config', 'server', config.server]);
    progress('API login');
    await bw(['login', '--apikey'], { BW_CLIENTID: config.clientId, BW_CLIENTSECRET: config.clientSecret });
    progress('vault unlock');
    const session = (await bw(['unlock', '--passwordenv', 'BW2KBDX_MASTER', '--raw'], { BW2KBDX_MASTER: config.masterPassword })).toString().trim();
    if (!session || /\s/.test(session)) throw new Error('Invalid session response');
    Object.assign(bwEnv, { BW_SESSION: session });
    progress('vault sync');
    await bw(['sync']);
    progress('personal vault export');
    const rawJson = (await bw(['export', '--format', 'json', '--raw'])).toString('utf8');
    const vault: unknown = JSON.parse(rawJson);
    validateVault(vault);
    progress('attachment inventory');
    // JSON exports omit attachment metadata. Inventory the same local synced vault.
    const inventory: Item[] = JSON.parse((await bw(['list', 'items', '--raw'])).toString('utf8'));
    if (!Array.isArray(inventory)) throw new Error('Invalid attachment inventory');
    const byId = new Map<string, Item>();
    for (const item of inventory) {
      if (!item || typeof item.id !== 'string' || byId.has(item.id)) throw new Error('Invalid attachment inventory item');
      byId.set(item.id, item);
    }
    const downloads: Download[] = [];
    progress('attachment download');
    for (const item of vault.items) {
      const source = byId.get(item.id);
      if (!source || source.organizationId || source.deletedDate) throw new Error('Personal vault and attachment inventory differ');
      if (source.attachments !== undefined && source.attachments !== null && !Array.isArray(source.attachments)) throw new Error('Invalid attachment metadata');
      const seen = new Set<string>();
      for (const attachment of source.attachments ?? []) {
        if (!attachment || typeof attachment.id !== 'string' || !attachment.id || seen.has(attachment.id) || typeof attachment.fileName !== 'string') throw new Error('Invalid attachment metadata');
        seen.add(attachment.id);
        // Raw attachment output preserves bytes and avoids using source filenames as paths.
        const data = await bw(['get', 'attachment', attachment.id, '--itemid', item.id, '--raw']);
        // The API reports encrypted file size (e.g. 65 bytes for 5 plaintext
        // bytes). The official CLI authenticates/decrypts the download; verify
        // its plaintext hash after importing the database instead of comparing
        // ciphertext size with plaintext length.
        if (attachment.size !== undefined && !/^\d+$/.test(String(attachment.size))) {
          throw new Error('Invalid attachment size metadata');
        }
        downloads.push({ itemId: item.id, id: attachment.id, fileName: attachment.fileName, data });
      }
    }
    progress('KeePass XML conversion');
    const conversion = convert(vault, rawJson, downloads);
    const xmlPath = join(workdir, 'vault.xml');
    await writeFile(xmlPath, conversion.xml, { mode: 0o600, flag: 'wx' });
    progress('output preparation');
    outputTemp = await mkdtemp(join(config.outputDir, '.bw2kbdx-'));
    await chmod(outputTemp, 0o700);
    const database = join(outputTemp, 'backup.kdbx');
    progress('KeePassXC import');
    await runner('keepassxc-cli', ['import', '--quiet', '--set-password', '--decryption-time', '1000', xmlPath, database], {
      cwd: workdir, env: baseEnv, input: `${config.backupPassword}\n${config.backupPassword}\n`, signal: options.signal,
    });
    await chmod(database, 0o600);
    progress('database verification');
    verifyHeader(await readFile(database));
    const verification = await runner('keepassxc-cli', ['export', '--quiet', '--format', 'xml', database], {
      cwd: workdir, env: baseEnv, input: `${config.backupPassword}\n`, signal: options.signal,
    });
    await verifyDatabase(database, verification.toString('utf8'), conversion, {
      cwd: workdir, env: baseEnv, input: `${config.backupPassword}\n`, signal: options.signal,
    }, runner);
    progress('atomic replacement');
    const file = await open(database, 'r');
    try { await file.sync(); } finally { await file.close(); }
    options.signal?.throwIfAborted();
    await rename(database, join(config.outputDir, 'backup.kdbx'));
    return { items: conversion.itemCount, attachments: conversion.attachmentCount };
  } catch {
    throw new SafeError(`Backup failed during ${stage}; no replacement was published`);
  } finally {
    // Cleanup failures must not mask the backup result. SIGKILL cleanup relies on container removal.
    if (outputTemp) await rm(outputTemp, { recursive: true, force: true }).catch(() => {});
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function main(): Promise<void> {
  process.umask(0o077);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const config = await loadConfig();
    // Secrets are explicitly scoped to each subprocess; do not inherit them accidentally.
    for (const key of ['BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD', 'KDBX_PASSWORD', 'BW_SESSION']) delete process.env[key];
    const result = await backup(config, { signal: abort.signal, progress: stage => console.log(`bw2kbdx: ${stage}`) });
    console.log(`bw2kbdx: verified backup published (${result.items} items, ${result.attachments} attachments)`);
  } catch (error) {
    console.error(`bw2kbdx: ${error instanceof SafeError ? error.message : 'Backup failed; details suppressed to protect secrets'}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

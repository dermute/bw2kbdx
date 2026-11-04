import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { convert } from '../src/convert.ts';
import { subprocessEnv } from '../src/config.ts';
import { run } from '../src/process.ts';
import { verifyHeader, verifyDatabase } from '../src/verify.ts';

const hasCli = (process.env.PATH ?? '').split(':').some(path => {
  try { accessSync(join(path, 'keepassxc-cli'), constants.X_OK); return true; } catch { return false; }
});

test('real verification extracts attachments from colliding entry and folder paths', { skip: !hasCli && !process.env.REQUIRE_KEEPASSXC }, async () => {
  assert.ok(hasCli, 'keepassxc-cli is required for integration testing');
  const dir = await mkdtemp(join(tmpdir(), 'bw2kbdx-duplicate-'));
  try {
    const vault = { folders: [{ id: 'a', name: 'Same / folder' }, { id: 'b', name: 'Same / folder' }], items: [
      { id: 'first', type: 2, name: 'Same entry', folderId: 'a' },
      { id: 'second', type: 2, name: 'Same entry', folderId: 'b' },
    ] };
    const conversion = convert(vault, JSON.stringify(vault), [
      { itemId: 'first', id: 'file-a', fileName: 'same.bin', data: Buffer.from([0, 255, 13]) },
      { itemId: 'second', id: 'file-b', fileName: 'same.bin', data: Buffer.from('different') },
    ]);
    const xml = join(dir, 'vault.xml');
    const db = join(dir, 'duplicate.kdbx');
    await writeFile(xml, conversion.xml, { mode: 0o600 });
    const options = { cwd: dir, env: subprocessEnv(dir), input: 'synthetic-backup-password\n' };
    await run('keepassxc-cli', ['import', '--quiet', '--set-password', '--decryption-time', '1000', xml, db], {
      ...options, input: 'synthetic-backup-password\nsynthetic-backup-password\n',
    });
    const original = await readFile(db);
    const exported = await run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], options);
    await verifyDatabase(db, exported.toString(), conversion, options);
    assert.deepEqual(await readFile(db), original, 'Verification must leave the published database unchanged');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real KeePassXC imports XML, reopens KDBX4, preserves data, and rejects incorrect passwords', { skip: !hasCli && !process.env.REQUIRE_KEEPASSXC }, async () => {
  assert.ok(hasCli, 'keepassxc-cli is required for integration testing');
  const permanent = process.env.ARTIFACT_DIR;
  const dir = permanent ?? await mkdtemp(join(tmpdir(), 'bw2kbdx-real-'));
  await mkdir(dir, { recursive: true });
  try {
    const { vault, downloads, raw } = fixture();
    const conversion = convert(vault, raw, downloads);
    const xml = join(dir, 'vault.xml');
    const db = join(dir, 'fixture.kdbx');
    await writeFile(xml, conversion.xml, { mode: 0o600 });
    const options = { cwd: dir, env: subprocessEnv(dir) };
    await run('keepassxc-cli', ['import', '--quiet', '--set-password', '--decryption-time', '1000', xml, db], {
      ...options, input: 'synthetic-backup-password\nsynthetic-backup-password\n',
    });
    verifyHeader(await readFile(db));
    const exported = await run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], { ...options, input: 'synthetic-backup-password\n' });
    await verifyDatabase(db, exported.toString(), conversion, { ...options, input: 'synthetic-backup-password\n' });
    await assert.rejects(run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], { ...options, input: 'wrong-password\n' }));
    if (permanent) await writeFile(join(dir, 'source.json'), raw);
  } finally { if (!permanent) await rm(dir, { recursive: true, force: true }); }
});

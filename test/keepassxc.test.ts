import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { convert } from '../src/convert.ts';
import { loadConfig, subprocessEnv } from '../src/config.ts';
import { backup } from '../src/backup.ts';
import { run } from '../src/process.ts';
import { verifyHeader, verifyDatabase } from '../src/verify.ts';

const hasCli = (process.env.PATH ?? '').split(':').some(path => {
  try { accessSync(join(path, 'keepassxc-cli'), constants.X_OK); return true; } catch { return false; }
});

for (const password of ['synthetic-backup-password', '']) {
  test(`real verification extracts attachments from colliding paths (${password ? 'password' : 'empty password'})`, { skip: !hasCli && !process.env.REQUIRE_KEEPASSXC }, async () => {
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
      const options = { cwd: dir, env: subprocessEnv(dir), input: `${password}\n` };
      await run('keepassxc-cli', ['import', '--quiet', '--set-password', '--decryption-time', '1000', xml, db], {
        ...options, input: password ? `${password}\n${password}\n` : '\ny\n',
      });
      const original = await readFile(db);
      const exported = await run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], options);
      await verifyDatabase(db, exported.toString(), conversion, options);
      assert.deepEqual(await readFile(db), original, 'Verification must leave the published database unchanged');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test(`real backup reopens KDBX4, preserves data, and rejects incorrect passwords (${password ? 'password' : 'empty password'})`, { skip: !hasCli && !process.env.REQUIRE_KEEPASSXC }, async () => {
    assert.ok(hasCli, 'keepassxc-cli is required for integration testing');
    const permanent = process.env.ARTIFACT_DIR;
    const dir = permanent ?? await mkdtemp(join(tmpdir(), 'bw2kbdx-real-'));
    await mkdir(dir, { recursive: true });
    try {
      const { vault, downloads, raw } = fixture();
      const conversion = convert(vault, raw, downloads);
      const config = await loadConfig({ BW_CLIENTID: 'user.test', BW_CLIENTSECRET: 'synthetic-client-secret',
        BW_PASSWORD: 'synthetic-master-password', KDBX_PASSWORD: password, BACKUP_DIR: dir,
        KDBX_FILE_MODE: password ? '0640' : '0644' });
      const result = await backup(config, { requireTmpfs: false, runner: async (program, args, options) => {
        if (program === 'keepassxc-cli') return run(program, args, options);
        assert.equal(program, 'bw');
        switch (args[1]) {
          case 'config': case 'login': case 'sync': return Buffer.alloc(0);
          case 'unlock': return Buffer.from('synthetic-session');
          case 'export': return Buffer.from(raw);
          case 'list': return Buffer.from(JSON.stringify(vault.items.map(item => ({ ...item,
            attachments: downloads.filter(d => d.itemId === item.id).map(d => ({ id: d.id, fileName: d.fileName })),
          }))));
          case 'get': {
            const attachment = downloads.find(d => d.id === args[3]);
            assert.ok(attachment);
            return attachment.data;
          }
          default: throw new Error('Unexpected Bitwarden command');
        }
      } });
      assert.deepEqual(result, { items: vault.items.length, attachments: downloads.length });
      const db = join(dir, 'backup.kdbx');
      assert.equal((await stat(db)).mode & 0o777, config.outputMode);
      const options = { cwd: dir, env: subprocessEnv(dir) };
      verifyHeader(await readFile(db));
      const exported = await run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], { ...options, input: `${password}\n` });
      await verifyDatabase(db, exported.toString(), conversion, { ...options, input: `${password}\n` });
      await assert.rejects(run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], { ...options, input: 'wrong-password\n' }));
      if (permanent) {
        await writeFile(join(dir, password ? 'fixture.kdbx' : 'fixture-empty.kdbx'), await readFile(db));
        await writeFile(join(dir, 'source.json'), raw);
      }
    } finally { if (!permanent) await rm(dir, { recursive: true, force: true }); }
  });
}

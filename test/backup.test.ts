import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from '../src/backup.ts';
import type { Config } from '../src/config.ts';
import type { Runner } from '../src/process.ts';
import { fixture, fakeHeader } from './fixture.ts';
import { child, children, parseXml } from '../src/xml.ts';

export async function harness(failAt?: string, corrupt = false, corruptAttachment = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bw2kbdx-pipeline-'));
  const outputDir = join(dir, 'output'); await mkdir(outputDir);
  const config: Config = { server: 'https://vault.example.test', clientId: 'test-client', clientSecret: 'client-secret',
    masterPassword: 'master-secret', backupPassword: 'backup-secret', outputDir };
  const calls: string[] = [];
  const { vault, raw, downloads } = fixture();
  let importedXml = '';
  const runner: Runner = async (program, args, options) => {
    const command = program === 'bw' ? args[1]! : args[0]!;
    calls.push(command);
    assert.ok(!args.includes(config.backupPassword));
    assert.ok(!args.includes(config.masterPassword));
    assert.equal(options.env.KDBX_PASSWORD, undefined);
    if (command === failAt) throw new Error('raw upstream error containing master-secret');
    if (program === 'bw') {
      if (command === 'login') {
        assert.equal(options.env.BW_CLIENTSECRET, config.clientSecret);
      } else if (command === 'unlock') {
        assert.equal(options.env.BW2KBDX_MASTER, config.masterPassword);
        assert.equal(options.env.BW_CLIENTSECRET, undefined);
        return Buffer.from('synthetic-session');
      } else if (command === 'export') {
        assert.equal(options.env.BW_SESSION, 'synthetic-session');
        return Buffer.from(raw);
      } else if (command === 'list') {
        return Buffer.from(JSON.stringify([...vault.items.map(item => ({ ...item, attachments: downloads.filter(d => d.itemId === item.id).map(d => ({ id: d.id, fileName: d.fileName, size: '65' })) })),
          { id: 'org-ignored', organizationId: 'org', attachments: [{ id: 'never-download' }] }]));
      } else if (command === 'get') {
        const attachment = downloads.find(d => d.id === args[3]);
        assert.ok(attachment);
        return attachment.data;
      }
    } else if (command === 'import') {
      assert.equal(options.input, 'backup-secret\nbackup-secret\n');
      importedXml = await readFile(args.at(-2)!, 'utf8');
      await writeFile(args.at(-1)!, fakeHeader());
      await chmod(args.at(-1)!, 0o600);
    } else if (command === 'export') {
      assert.equal(options.input, 'backup-secret\n');
      return Buffer.from(corrupt ? importedXml.replace('https://other.example.test/login', 'wrong') : importedXml);
    } else if (command === 'attachment-export') {
      const xml = parseXml(importedXml);
      function find(node: ReturnType<typeof parseXml>): ReturnType<typeof parseXml> | undefined {
        return children(node, 'Binary').find(binary => children(binary, 'Key').some(key => key.text === args.at(-2)))
          ?? node.children.map(find).find(Boolean);
      }
      const ref = child(find(xml)!, 'Value').attrs.Ref;
      const pool = children(child(child(xml, 'Meta'), 'Binaries'), 'Binary');
      const data = Buffer.from(pool.find(binary => binary.attrs.ID === ref)!.text, 'base64');
      await writeFile(args.at(-1)!, corruptAttachment ? Buffer.concat([data, Buffer.from('corrupt')]) : data);
    } else throw new Error('Unexpected CLI command');
    return Buffer.alloc(0);
  };
  return { dir, config, runner, calls };
}

test('one-shot pipeline syncs, exports, downloads, verifies, atomically replaces and cleans up', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.config.outputDir, 'backup.kdbx'), 'previous backup');
    assert.deepEqual(await backup(h.config, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false }), { items: 6, attachments: 3 });
    assert.deepEqual(await readFile(join(h.config.outputDir, 'backup.kdbx')), fakeHeader());
    assert.equal((await stat(join(h.config.outputDir, 'backup.kdbx'))).mode & 0o777, 0o600);
    assert.deepEqual(h.calls, ['config', 'login', 'unlock', 'sync', 'export', 'list', 'get', 'get', 'get', 'import', 'export',
      ...Array(5).fill('attachment-export')]);
    assert.deepEqual(await readdir(h.dir), ['output']);
    assert.deepEqual(await readdir(h.config.outputDir), ['backup.kdbx']);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

for (const failAt of ['login', 'unlock', 'sync', 'get', 'import', 'attachment-export']) {
  test(`failure at ${failAt} preserves the last backup and sanitizes diagnostics`, async () => {
    const h = await harness(failAt);
    try {
      await writeFile(join(h.config.outputDir, 'backup.kdbx'), 'previous backup');
      await assert.rejects(backup(h.config, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false }), error => {
        assert.ok(!String(error).includes('master-secret'));
        return true;
      });
      assert.equal(await readFile(join(h.config.outputDir, 'backup.kdbx'), 'utf8'), 'previous backup');
      assert.deepEqual(await readdir(h.dir), ['output']);
      assert.deepEqual(await readdir(h.config.outputDir), ['backup.kdbx']);
    } finally { await rm(h.dir, { recursive: true, force: true }); }
  });
}

test('verification failure preserves previous database', async () => {
  const h = await harness(undefined, true);
  try {
    await writeFile(join(h.config.outputDir, 'backup.kdbx'), 'previous backup');
    await assert.rejects(backup(h.config, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false }), /database verification/);
    assert.equal(await readFile(join(h.config.outputDir, 'backup.kdbx'), 'utf8'), 'previous backup');
    assert.deepEqual(await readdir(h.config.outputDir), ['backup.kdbx']);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test('corrupted extracted attachment preserves the previous backup', async () => {
  const h = await harness(undefined, false, true);
  try {
    await writeFile(join(h.config.outputDir, 'backup.kdbx'), 'previous backup');
    await assert.rejects(backup(h.config, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false }), /database verification/);
    assert.equal(await readFile(join(h.config.outputDir, 'backup.kdbx'), 'utf8'), 'previous backup');
    assert.deepEqual(await readdir(h.dir), ['output']);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test('cancellation and unavailable output preserve the last backup', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.config.outputDir, 'backup.kdbx'), 'previous backup');
    const controller = new AbortController();
    await assert.rejects(backup(h.config, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false,
      signal: controller.signal, progress: stage => { if (stage === 'database verification') controller.abort(); } }));
    assert.equal(await readFile(join(h.config.outputDir, 'backup.kdbx'), 'utf8'), 'previous backup');
    await assert.rejects(backup({ ...h.config, outputDir: join(h.dir, 'missing') }, { runner: h.runner, tempRoot: h.dir, requireTmpfs: false }), /output preparation/);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

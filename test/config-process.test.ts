import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, subprocessEnv } from '../src/config.ts';
import { run } from '../src/process.ts';

const secrets = { BW_CLIENTID: 'user.test', BW_CLIENTSECRET: 'client secret', BW_PASSWORD: 'master secret', KDBX_PASSWORD: ' backup secret ' };

test('configuration reads secrets without trimming intentional spaces and rejects conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw2kbdx-config-'));
  try {
    const path = join(dir, 'password'); await writeFile(path, ' backup secret \n');
    const config = await loadConfig({ ...secrets, KDBX_PASSWORD: undefined, KDBX_PASSWORD_FILE: path });
    assert.equal(config.backupPassword, ' backup secret ');
    assert.equal(config.server, 'https://vault.bitwarden.com');
    await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD_FILE: path }), /Set only/);
    await assert.rejects(loadConfig({ ...secrets, BW_PASSWORD: 'bad\npassword' }), /single-line/);
    await assert.rejects(loadConfig({ ...secrets, BW_SERVER: 'https://user:secret@example.test' }), /base URL/);
    await assert.rejects(loadConfig({ ...secrets, BW_SERVER: 'http://vault.example.test' }), /HTTPS base URL/);
    await assert.rejects(loadConfig({ ...secrets, BW_CLIENTSECRET: '' }), /BW_CLIENTSECRET/);
    await assert.rejects(loadConfig({ ...secrets, BW_PASSWORD: undefined, BW_PASSWORD_FILE: join(dir, 'missing') }), /Cannot read BW_PASSWORD_FILE/);
    const env = subprocessEnv(dir, { ...secrets, BW_SESSION: 'session', RANDOM_SECRET: 'secret', PATH: '/bin' });
    assert.equal(env.BW_PASSWORD, undefined);
    assert.equal(env.RANDOM_SECRET, undefined);
    assert.equal(env.BW_SESSION, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('subprocess runner preserves binary output and suppresses diagnostics on failure', async () => {
  const options = { env: process.env, cwd: tmpdir() };
  assert.deepEqual(await run('/bin/sh', ['-c', "printf '\\000\\377\\200\\015\\012'"], options), Buffer.from([0,255,128,13,10]));
  await assert.rejects(run('/bin/sh', ['-c', 'echo super-secret >&2; exit 2'], options), error => !String(error).includes('super-secret'));
  await assert.rejects(run('/bin/sh', ['-c', 'exec sleep 10'], { ...options, timeoutMs: 30 }));
  await assert.rejects(run('/bin/sh', ['-c', 'echo too-much'], { ...options, maxBytes: 2 }));
  await assert.rejects(run('/nonexistent-bw2kbdx', [], options));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run('/bin/sh', ['-c', 'exec sleep 10'], { ...options, signal: controller.signal }));
});

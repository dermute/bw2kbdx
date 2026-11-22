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

test('an explicitly empty KDBX password is accepted from the environment or a secret file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw2kbdx-config-'));
  try {
    assert.equal((await loadConfig({ ...secrets, KDBX_PASSWORD: '' })).backupPassword, '');
    const path = join(dir, 'password');
    for (const contents of ['', '\n', '\r\n']) {
      await writeFile(path, contents);
      assert.equal((await loadConfig({ ...secrets, KDBX_PASSWORD: undefined, KDBX_PASSWORD_FILE: path })).backupPassword, '');
    }
    await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD: undefined }), /KDBX_PASSWORD/);
    await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD: '', KDBX_PASSWORD_FILE: path }), /Set only/);
    await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD: undefined, KDBX_PASSWORD_FILE: join(dir, 'missing') }), /Cannot read KDBX_PASSWORD_FILE/);
    for (const value of ['bad\npassword', 'bad\rpassword', 'bad\0password']) {
      await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD: value }), /single-line/);
      await writeFile(path, value);
      await assert.rejects(loadConfig({ ...secrets, KDBX_PASSWORD: undefined, KDBX_PASSWORD_FILE: path }), /single-line/);
    }
    for (const name of ['BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD']) {
      await assert.rejects(loadConfig({ ...secrets, [name]: '' }), new RegExp(name));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('KDBX file permissions default to 0600 and accept only octal permission bits', async () => {
  assert.equal((await loadConfig(secrets)).outputMode, 0o600);
  for (const [value, expected] of [['600', 0o600], ['0600', 0o600], ['640', 0o640], ['0640', 0o640],
    ['0644', 0o644], ['0660', 0o660], ['0664', 0o664], ['0440', 0o440], ['000', 0o000], ['0000', 0o000], ['0777', 0o777]] as const) {
    assert.equal((await loadConfig({ ...secrets, KDBX_FILE_MODE: value })).outputMode, expected);
  }
  for (const value of ['', '0', '60', '888', '0680', '0o640', '0x1a0', '1000', '1644', '4644', '-600', ' 640', '640 ', '640\n', '644junk']) {
    await assert.rejects(loadConfig({ ...secrets, KDBX_FILE_MODE: value }), /KDBX_FILE_MODE/);
  }
});

test('a stable device UUID is optional, normalized, and validated without logging its value', async () => {
  assert.equal((await loadConfig(secrets)).deviceIdentifier, undefined);
  assert.equal((await loadConfig({ ...secrets, BW_DEVICE_IDENTIFIER: '' })).deviceIdentifier, undefined);
  const uuid = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
  assert.equal((await loadConfig({ ...secrets, BW_DEVICE_IDENTIFIER: uuid })).deviceIdentifier, uuid.toLowerCase());
  for (const value of ['not-a-uuid', 'abcdef01-2345-4678-9abc-def01234567', `${uuid}\n`, ` ${uuid}`, `${uuid} `]) {
    await assert.rejects(loadConfig({ ...secrets, BW_DEVICE_IDENTIFIER: value }), error => {
      assert.match(String(error), /BW_DEVICE_IDENTIFIER must be a UUID/);
      assert.ok(!String(error).includes(value));
      return true;
    });
  }
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

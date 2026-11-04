/** Disposable-server integration fixture only. Runtime code never implements
 * Bitwarden cryptography; the official CLI handles it. Account registration
 * below creates a synthetic account on the isolated CI Vaultwarden service.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup } from '../src/backup.ts';
import { subprocessEnv } from '../src/config.ts';
import { run } from '../src/process.ts';
import { child, children, parseXml } from '../src/xml.ts';
import { fixture } from './fixture.ts';

assert.equal(process.env.BW2KBDX_DISPOSABLE_TEST, '1', 'This script requires an isolated disposable server');
const server = process.env.TEST_VAULTWARDEN_URL ?? 'https://vaultwarden';
const email = `backup-${randomUUID()}@example.test`;
const password = 'synthetic-master-for-ci-only';
const workdir = await mkdtemp('/tmp/bw2kbdx-vw-');
const env = { ...subprocessEnv(workdir), BITWARDENCLI_APPDATA_DIR: join(workdir, 'cli'), BW_NOINTERACTION: 'true' };
async function request(path: string, body: object | URLSearchParams, token?: string): Promise<any> {
  const response = await fetch(`${server}${path}`, { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body instanceof URLSearchParams ? body : JSON.stringify(body),
  });
  assert.ok(response.ok, `Disposable fixture request ${path} failed with HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
const bw = async (args: string[], extra: NodeJS.ProcessEnv = {}) => run('bw', ['--nointeraction', ...args], { cwd: workdir, env: { ...env, ...extra } });

try {
  // Bitwarden registration fixture: PBKDF2 master key, expanded encryption/MAC
  // keys, and an authenticated encrypted random user key. These are test data.
  const master = pbkdf2Sync(password, email, 600000, 32, 'sha256');
  const hash = pbkdf2Sync(master, password, 1, 32, 'sha256').toString('base64');
  const expand = (label: string) => createHmac('sha256', master).update(Buffer.concat([Buffer.from(label), Buffer.from([1])])).digest();
  function encrypt(data: Buffer, encryptionKey: Buffer, macKey: Buffer): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, encrypted])).digest();
    return `2.${iv.toString('base64')}|${encrypted.toString('base64')}|${mac.toString('base64')}`;
  }
  const userKey = randomBytes(64);
  const key = encrypt(userKey, expand('enc'), expand('mac'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  const keys = { publicKey: publicKey.toString('base64'), encryptedPrivateKey: encrypt(privateKey, userKey.subarray(0, 32), userKey.subarray(32)) };
  // With SMTP disabled, Vaultwarden returns this registration token directly.
  const emailVerificationToken = await request('/identity/accounts/register/send-verification-email', { email, name: 'Synthetic CI account' });
  assert.equal(typeof emailVerificationToken, 'string');
  await request('/identity/accounts/register/finish', { email, emailVerificationToken, masterPasswordHash: hash, key, keys, kdf: 0, kdfIterations: 600000 });
  const token = await request('/identity/connect/token', new URLSearchParams({ grant_type: 'password', username: email, password: hash,
    scope: 'api offline_access', client_id: 'cli', deviceType: '8', deviceIdentifier: randomUUID(), deviceName: 'bw2kbdx-ci' }));
  const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString());
  const api = await request('/api/accounts/api-key', { masterPasswordHash: hash }, token.access_token);
  await bw(['config', 'server', server]);
  const credentials = { BW_CLIENTID: `user.${claims.sub}`, BW_CLIENTSECRET: api.apiKey };
  await bw(['login', '--apikey'], credentials);
  const session = (await bw(['unlock', '--passwordenv', 'TEST_PASSWORD', '--raw'], { TEST_PASSWORD: password })).toString().trim();
  Object.assign(env, { BW_SESSION: session });
  const { vault } = fixture();
  vault.items = vault.items.filter(item => item.type <= 4);
  // The current SDK validates imported identifiers as UUIDs.
  const folderIds = new Map(vault.folders.map(folder => [folder.id, randomUUID()]));
  for (const folder of vault.folders) folder.id = folderIds.get(folder.id)!;
  for (const item of vault.items) {
    item.id = randomUUID();
    if (item.folderId) item.folderId = folderIds.get(item.folderId)!;
  }
  for (const item of vault.items) if (item.login) delete item.login.fido2Credentials;
  const input = join(workdir, 'seed.json');
  await writeFile(input, JSON.stringify(vault), { mode: 0o600 });
  await bw(['import', 'bitwardenjson', input]);
  await bw(['sync']);
  const items = JSON.parse((await bw(['list', 'items', '--raw'])).toString());
  const login = items.find((item: any) => item.name === vault.items[0]!.name);
  assert.ok(login, 'Imported login missing');
  const attachment = join(workdir, 'duplicate.bin');
  for (const data of [Buffer.from([0, 255, 128, 13, 10]), Buffer.from('second attachment')]) {
    await writeFile(attachment, data, { mode: 0o600 });
    await bw(['create', 'attachment', '--file', attachment, '--itemid', login.id]);
  }
  const outputDir = join(workdir, 'output'); await mkdir(outputDir);
  const config = { server, clientId: credentials.BW_CLIENTID, clientSecret: api.apiKey, masterPassword: password,
    backupPassword: 'synthetic-backup-password', outputDir };
  assert.deepEqual(await backup(config), { items: 4, attachments: 2 });
  const db = join(outputDir, 'backup.kdbx');
  const exported = await run('keepassxc-cli', ['export', '--quiet', '--format', 'xml', db], {
    cwd: workdir, env: subprocessEnv(workdir), input: 'synthetic-backup-password\n',
  });
  const parsed = parseXml(exported.toString());
  function entries(node: ReturnType<typeof parseXml>): ReturnType<typeof parseXml>[] {
    return [...children(node, 'Entry'), ...node.children.flatMap(n => n.name === 'Entry' ? [] : entries(n))];
  }
  const found = entries(parsed).find(entry => children(entry, 'String').some(s => child(s, 'Key').text === 'Title' && child(s, 'Value').text === login.name))!;
  const urls = Object.fromEntries(children(found, 'String').map(s => [child(s, 'Key').text, child(s, 'Value').text]));
  assert.equal(urls.KP2A_URL_1, 'https://other.example.test/login');
  assert.equal(urls.KP2A_URL_2, 'androidapp://org.example.app');
  assert.equal(children(found, 'Binary').length, 3); // two originals plus attachment recovery metadata
  const previous = await readFile(db);
  await assert.rejects(backup({ ...config, masterPassword: 'deliberately-wrong' }));
  assert.deepEqual(await readFile(db), previous);
  console.log('Disposable Vaultwarden integration passed');
} finally { await rm(workdir, { recursive: true, force: true }); }

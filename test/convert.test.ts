import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, validateVault } from '../src/convert.ts';
import { verifyXml, verifyHeader } from '../src/verify.ts';
import { element, serialize, parseXml } from '../src/xml.ts';
import { fixture, fakeHeader } from './fixture.ts';

test('preserves vault data, multiple URLs, custom collisions, binary attachments, timestamps and original JSON', () => {
  const { vault, downloads, raw } = fixture();
  const result = convert(vault, raw, downloads);
  assert.equal(result.itemCount, 6);
  assert.equal(result.attachmentCount, 3);
  verifyXml(result.xml, result);
  verifyXml(result.xml.replaceAll('&#13;', '\r'), result); // Qt plaintext-export behavior
  const login = result.entries.find(entry => entry.fields['Bitwarden.ID'] === 'login-1')!;
  assert.equal(login.fields.URL, 'https://example.test/?x=1&y=2');
  assert.equal(login.fields.KP2A_URL_1, 'https://other.example.test/login');
  assert.equal(login.fields.KP2A_URL_2, 'androidapp://org.example.app');
  assert.equal(login.fields['Bitwarden field:KP2A_URL_1'], 'original-custom-url-field');
  assert.equal(login.fields['Bitwarden field:Password'], 'separate-custom-value');
  assert.equal(login.fields['duplicate (2)'], 'two');
  assert.equal(login.fields.__proto__, 'literal-property');
  assert.equal(login.fields['Bitwarden field:Bitwarden.ID'], 'user-custom-id');
  assert.equal(Object.keys(login.attachments).length, 4);
  assert.equal(login.created, '2024-01-02T03:04:05Z');
  assert.match(result.xml, /ProtectInMemory="True"/);
});

test('empty vault is valid and still contains a recovery export', () => {
  const vault = { folders: [], items: [] };
  const result = convert(vault, JSON.stringify(vault), []);
  assert.equal(result.entries.length, 1);
  verifyXml(result.xml, result);
});

test('verification rejects lost or changed URLs, secrets, attachments and timestamps', () => {
  const { vault, downloads, raw } = fixture();
  const result = convert(vault, raw, downloads);
  for (const changed of [
    result.xml.replace('https://other.example.test/login', 'https://wrong.test'),
    result.xml.replace('synthetic-secret', 'lost-secret'),
    result.xml.replace('2024-01-02T03:04:05Z', '2024-01-03T03:04:05Z'),
    result.xml.replace('AAH/gA0K', 'AAH/gA0L'),
    result.xml.replace('Work / &lt;重要&gt; &amp; personal', 'Changed folder'),
  ]) assert.throws(() => verifyXml(changed, result));
});

test('rejects invalid, encrypted, shared, deleted, duplicate, and inconsistent source data', () => {
  assert.throws(() => validateVault({ folders: [], items: [], encrypted: true }));
  for (const change of [
    (v: ReturnType<typeof fixture>['vault']) => { v.items[0]!.organizationId = 'shared'; },
    (v: ReturnType<typeof fixture>['vault']) => { v.items[0]!.deletedDate = '2026-01-01'; },
    (v: ReturnType<typeof fixture>['vault']) => { v.items.push(v.items[0]!); },
    (v: ReturnType<typeof fixture>['vault']) => { v.items[0]!.folderId = 'missing'; },
    (v: ReturnType<typeof fixture>['vault']) => { v.items[0]!.name = 'bad\u0000text'; },
    (v: ReturnType<typeof fixture>['vault']) => { v.items[0]!.creationDate = 'invalid'; },
  ]) {
    const { vault, raw } = fixture(); change(vault);
    assert.throws(() => convert(vault, raw, []));
  }
});

test('XML escapes text, retains CR and Unicode, rejects entities and malformed markup', () => {
  const text = 'quotes "\' & < >\r\n\temoji 🔐';
  assert.equal(parseXml(serialize(element('Text', text))).text, text);
  for (const xml of ['<!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>', '<x>&unknown;</x>', '<x><y></x>', '<x a="1" a="2"/>', '<x/ ><y/>', '<x>&#0;</x>']) {
    assert.throws(() => parseXml(xml));
  }
});

test('validates the public KDBX4 cipher and KDF header without doing cryptography', () => {
  const header = fakeHeader();
  verifyHeader(header);
  assert.throws(() => verifyHeader(header.subarray(0, 15)));
  const badCipher = Buffer.from(header); badCipher[17] = 0;
  assert.throws(() => verifyHeader(badCipher));
  const badKdf = Buffer.from(header); badKdf[badKdf.indexOf(Buffer.from('c9d9f39a', 'hex'))] = 0;
  assert.throws(() => verifyHeader(badKdf));
});

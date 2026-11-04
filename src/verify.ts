import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { child, children, parseXml } from './xml.ts';
import type { Element } from './xml.ts';
import type { Conversion, ManifestEntry } from './model.ts';
import { sha256 } from './convert.ts';
import { run } from './process.ts';
import type { CommandOptions, Runner } from './process.ts';

function decode(value: string): Buffer {
  const compact = value.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('Invalid base64 in verification XML');
  return Buffer.from(compact, 'base64');
}

function time(value: string): string {
  // KeePassXC may export ISO timestamps or KDBX4 seconds since year 1.
  if (/^\d{4}-/.test(value)) return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const bytes = decode(value);
  if (bytes.length !== 8) throw new Error('Invalid verification timestamp');
  return new Date(Number(bytes.readBigUInt64LE() - 62135596800n) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function verifyXml(xml: string, expected: Conversion, extracted?: Map<string, Record<string, string>>): void {
  // Qt's plaintext exporter emits literal CR inside text instead of &#13;.
  // Preserve it here so verification compares the actual stored protected values,
  // rather than normalizing CRLF passwords/notes into different strings.
  const document = parseXml(xml, true);
  if (document.name !== 'KeePassFile') throw new Error('Unexpected verification XML');
  const pool = new Map<string, Buffer>();
  for (const binaries of children(child(document, 'Meta'), 'Binaries')) {
    for (const binary of children(binaries, 'Binary')) {
      if (!binary.attrs.ID || pool.has(binary.attrs.ID)) throw new Error('Invalid binary pool');
      const data = decode(binary.text);
      pool.set(binary.attrs.ID, binary.attrs.Compressed?.toLowerCase() === 'true' ? gunzipSync(data) : data);
    }
  }
  const actual = new Map<string, ManifestEntry>();
  const groups: Record<string, string> = Object.create(null);
  function visit(group: Element): void {
    const folder = child(group, 'UUID').text;
    if (Object.hasOwn(groups, folder)) throw new Error('Duplicate verification group');
    groups[folder] = child(group, 'Name').text;
    for (const entry of children(group, 'Entry')) {
      const uuid = child(entry, 'UUID').text;
      if (actual.has(uuid)) throw new Error('Duplicate verification entry');
      const fields: Record<string, string> = Object.create(null);
      const attachments: Record<string, string> = Object.create(null);
      for (const string of children(entry, 'String')) {
        const key = child(string, 'Key').text;
        const value = child(string, 'Value');
        if (Object.hasOwn(fields, key) || value.attrs.Protected?.toLowerCase() === 'true') throw new Error('Invalid verification field');
        fields[key] = value.text;
      }
      for (const binary of children(entry, 'Binary')) {
        const key = child(binary, 'Key').text;
        const value = child(binary, 'Value');
        if (Object.hasOwn(attachments, key)) throw new Error('Duplicate verification attachment');
        if (extracted) {
          const hash = extracted.get(uuid)?.[key];
          if (!hash) throw new Error('Missing extracted verification attachment');
          attachments[key] = hash;
        } else {
          const data = value.attrs.Ref === undefined ? decode(value.text) : pool.get(value.attrs.Ref);
          if (!data) throw new Error('Invalid verification attachment');
          attachments[key] = sha256(data);
        }
      }
      const times = child(entry, 'Times');
      actual.set(uuid, { uuid, folder, fields, attachments,
        created: time(child(times, 'CreationTime').text), modified: time(child(times, 'LastModificationTime').text) });
    }
    for (const nested of children(group, 'Group')) visit(nested);
  }
  visit(child(child(document, 'Root'), 'Group'));
  if (!isDeepStrictEqual({ ...groups }, { ...expected.groups })) throw new Error('Verification folder mismatch');
  if (actual.size !== expected.entries.length) throw new Error('Verification entry count mismatch');
  for (const entry of expected.entries) {
    const found = actual.get(entry.uuid);
    if (!found || found.folder !== entry.folder || !isDeepStrictEqual({ ...found.fields }, { ...entry.fields }) ||
      !isDeepStrictEqual({ ...found.attachments }, { ...entry.attachments }) ||
      (entry.created && entry.created !== found.created) || (entry.modified && entry.modified !== found.modified)) {
      throw new Error('Database content verification failed; backup unchanged');
    }
  }
}

/** KeePassXC 2.8's KDBX4 XML export omits binary data. Extract attachment bytes
 * through its CLI instead, then verify those hashes alongside the XML metadata.
 */
export async function verifyDatabase(database: string, xml: string, expected: Conversion,
  options: CommandOptions, runner: Runner = run): Promise<void> {
  const routes: { uuid: string; path: string; names: string[] }[] = [];
  function visit(group: Element, path: string): void {
    for (const entry of children(group, 'Entry')) {
      const title = children(entry, 'String').find(s => child(s, 'Key').text === 'Title');
      if (!title) throw new Error('Missing verification title');
      routes.push({ uuid: child(entry, 'UUID').text, path: path + child(title, 'Value').text,
        names: children(entry, 'Binary').map(binary => child(binary, 'Key').text) });
    }
    for (const nested of children(group, 'Group')) visit(nested, path + child(nested, 'Name').text + '/');
  }
  visit(child(child(parseXml(xml, true), 'Root'), 'Group'), '/');
  const expectedById = new Map(expected.entries.map(entry => [entry.uuid, entry]));
  if (routes.length !== expectedById.size || new Set(routes.map(route => route.uuid)).size !== routes.length) {
    throw new Error('Verification entry count mismatch');
  }
  for (const route of routes) {
    const entry = expectedById.get(route.uuid);
    if (!entry || !isDeepStrictEqual([...route.names].sort(), Object.keys(entry.attachments).sort())) {
      throw new Error('Verification attachment names mismatch');
    }
  }
  const counts = new Map<string, number>();
  for (const route of routes) counts.set(route.path, (counts.get(route.path) ?? 0) + 1);
  const ambiguous = new Set(routes.filter(route => route.names.length && counts.get(route.path)! > 1).map(route => route.path));
  const scratch = await mkdtemp(join(options.cwd, 'verify-'));
  const workingCopy = join(scratch, 'verification.kdbx');
  const target = join(scratch, 'attachment');
  const hashes = new Map<string, Record<string, string>>();
  try {
    // CLI attachment commands resolve the first matching path. For collisions,
    // remove each verified entry from a scratch copy to reach the next one.
    // Our generated database disables the recycle bin; the published file is untouched.
    if (ambiguous.size) await copyFile(database, workingCopy);
    for (const route of routes) {
      const source = ambiguous.has(route.path) ? workingCopy : database;
      const attachments: Record<string, string> = Object.create(null);
      for (const name of route.names) {
        await runner('keepassxc-cli', ['attachment-export', '--quiet', '--', source, route.path, name, target], options);
        attachments[name] = sha256(await readFile(target));
        await rm(target);
      }
      hashes.set(route.uuid, attachments);
      if (ambiguous.has(route.path)) await runner('keepassxc-cli', ['rm', '--quiet', workingCopy, route.path], options);
    }
    verifyXml(xml, expected, hashes);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Validate public KDBX headers only. KeePassXC verifies/decrypts the database. */
export function verifyHeader(data: Buffer): void {
  if (data.length < 12 || data.readUInt32LE(0) !== 0x9aa2d903 || data.readUInt32LE(4) !== 0xb54bfb67 || data.readUInt16LE(10) !== 4) {
    throw new Error('Expected a KDBX 4 database');
  }
  let cipher = false;
  let aesKdf = false;
  let rounds = false;
  let ended = false;
  let offset = 12;
  while (offset + 5 <= data.length) {
    const id = data[offset]!;
    const size = data.readUInt32LE(offset + 1);
    offset += 5;
    if (offset + size > data.length) throw new Error('Truncated KDBX header');
    const value = data.subarray(offset, offset + size);
    offset += size;
    if (id === 0) { ended = true; break; }
    if (id === 2) cipher = value.toString('hex') === '31c1f2e6bf714350be5805216afc5aff';
    if (id === 11) {
      let index = 2; // VariantDictionary version
      while (index < value.length && value[index] !== 0) {
        const type = value[index++]!;
        if (index + 4 > value.length) throw new Error('Invalid KDF header');
        const keySize = value.readUInt32LE(index); index += 4;
        if (index + keySize + 4 > value.length) throw new Error('Invalid KDF header');
        const key = value.subarray(index, index + keySize).toString(); index += keySize;
        const valueSize = value.readUInt32LE(index); index += 4;
        if (index + valueSize > value.length) throw new Error('Invalid KDF header');
        if (key === '$UUID' && type === 0x42) aesKdf = value.subarray(index, index + valueSize).toString('hex') === 'c9d9f39a628a4460bf740d08c18a4fea';
        if (key === 'R' && type === 0x05 && valueSize === 8) rounds = value.readBigUInt64LE(index) > 0n;
        index += valueSize;
      }
    }
  }
  if (!ended || !cipher || !aesKdf || !rounds) throw new Error('Database must use KDBX4, AES-256 and calibrated AES-KDF');
}

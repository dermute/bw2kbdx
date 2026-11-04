import { createHash } from 'node:crypto';
import { element as e, serialize } from './xml.ts';
import type { Element } from './xml.ts';
import type { Vault, Download, Conversion, ManifestEntry, Item } from './model.ts';

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const uuid = (value: string): string => createHash('sha256').update(value).digest().subarray(0, 16).toString('base64');
const rootUuid = uuid('bw2kbdx:root');
const recoveryUuid = uuid('bw2kbdx:recovery-group');
const safeRecord = (): Record<string, string> => Object.create(null);

export function validateVault(value: unknown): asserts value is Vault {
  const vault = value as Vault;
  if (!vault || vault.encrypted === true || !Array.isArray(vault.items) || !Array.isArray(vault.folders)) {
    throw new Error('Expected an unencrypted Bitwarden JSON export');
  }
  const ids = new Set<string>();
  for (const folder of vault.folders) {
    if (!folder || typeof folder.id !== 'string' || !folder.id || typeof folder.name !== 'string' || ids.has(folder.id)) {
      throw new Error('Invalid or duplicate source folder');
    }
    ids.add(folder.id);
  }
  ids.clear();
  for (const item of vault.items) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !Number.isInteger(item.type) || ids.has(item.id)) {
      throw new Error('Invalid or duplicate source item');
    }
    if (item.organizationId || item.deletedDate) throw new Error('Export unexpectedly contains shared or deleted items');
    if (item.login?.uris && (!Array.isArray(item.login.uris) || item.login.uris.some(uri => !uri || (uri.uri !== null && typeof uri.uri !== 'string')))) {
      throw new Error('Invalid source URI list');
    }
    if (item.fields && (!Array.isArray(item.fields) || item.fields.some(field => !field || (field.name !== null && typeof field.name !== 'string') || (field.value !== null && typeof field.value !== 'string')))) {
      throw new Error('Invalid source custom fields');
    }
    ids.add(item.id);
  }
}

function timestamp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid source timestamp');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function times(created: string, modified: string): Element {
  return e('Times', '', [
    e('CreationTime', created), e('LastModificationTime', modified), e('LastAccessTime', modified),
    e('ExpiryTime', modified), e('Expires', 'False'), e('UsageCount', '0'), e('LocationChanged', modified),
  ]);
}

function otp(item: Item): string | undefined {
  const secret = item.login?.totp;
  if (!secret) return undefined;
  if (secret.startsWith('otpauth://')) return secret;
  if (/^[A-Z2-7]+=*$/i.test(secret.replace(/\s/g, ''))) {
    return `otpauth://totp/${encodeURIComponent(item.name)}?secret=${encodeURIComponent(secret.replace(/\s/g, ''))}`;
  }
  return undefined; // Nonstandard seeds remain in Bitwarden.TOTP and the source JSON.
}

export function convert(vault: Vault, rawJson: string, downloads: Download[], now = new Date()): Conversion {
  validateVault(vault);
  const binaryPool: Element[] = [];
  const entries: ManifestEntry[] = [];
  const groups = new Map<string, Element>();
  const groupIds = new Map<string, string>();
  const groupNames = safeRecord();
  groupNames[rootUuid] = 'Bitwarden';
  groupNames[recoveryUuid] = 'bw2kbdx recovery';
  const defaultTime = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const root = e('Group', '', [e('UUID', rootUuid), e('Name', 'Bitwarden'), times(defaultTime, defaultTime),
    // Group custom data requires KDBX4, which also authenticates the encrypted payload.
    e('CustomData', '', [e('Item', '', [e('Key', 'bw2kbdx.format'), e('Value', '1')])]),
  ]);
  for (const folder of vault.folders) {
    const id = uuid(`folder:${folder.id}`);
    const group = e('Group', '', [e('UUID', id), e('Name', folder.name), times(defaultTime, defaultTime)]);
    groups.set(folder.id, group);
    groupIds.set(folder.id, id);
    groupNames[id] = folder.name;
    root.children.push(group);
  }

  function addEntry(fields: Record<string, string>, folder: string, created: string | undefined, modified: string | undefined,
    binaries: { name: string; data: Buffer }[], id: string, parent: Element): void {
    const manifest: ManifestEntry = { uuid: id, fields, folder, attachments: safeRecord(), created, modified };
    const node = e('Entry', '', [e('UUID', id), times(created ?? defaultTime, modified ?? defaultTime)]);
    for (const [key, value] of Object.entries(fields)) {
      node.children.push(e('String', '', [e('Key', key), e('Value', value, [], { ProtectInMemory: 'True' })]));
    }
    for (const binary of binaries) {
      const ref = String(binaryPool.length);
      binaryPool.push(e('Binary', binary.data.toString('base64'), [], { ID: ref, Compressed: 'False' }));
      node.children.push(e('Binary', '', [e('Key', binary.name), e('Value', '', [], { Ref: ref })]));
      manifest.attachments[binary.name] = sha256(binary.data);
    }
    parent.children.push(node);
    entries.push(manifest);
  }

  const expectedDownloads = new Set<string>();
  for (const item of vault.items) {
    const parent = item.folderId ? groups.get(item.folderId) : root;
    if (!parent) throw new Error('Source item references a missing folder');
    const fields = safeRecord();
    fields.Title = item.name;
    fields.UserName = item.login?.username ?? '';
    fields.Password = item.login?.password ?? '';
    fields.Notes = item.notes ?? '';
    const uris = (item.login?.uris ?? []).map(uri => uri.uri).filter((uri): uri is string => Boolean(uri));
    fields.URL = uris[0] ?? '';
    for (let index = 1; index < uris.length; index++) fields[`KP2A_URL_${index}`] = uris[index]!;
    fields['Bitwarden.ID'] = item.id;
    fields['Bitwarden.Type'] = String(item.type);
    fields['Bitwarden.Favorite'] = String(item.favorite ?? false);
    if (item.login?.totp) fields['Bitwarden.TOTP'] = item.login.totp;
    const nativeOtp = otp(item);
    if (nativeOtp) fields.otp = nativeOtp;
    for (const key of ['card', 'identity', 'sshKey', 'secureNote']) {
      if (item[key] !== null && item[key] !== undefined) fields[`Bitwarden.${key}`] = JSON.stringify(item[key]);
    }
    const generatedFields = new Set(Object.keys(fields));
    for (const custom of item.fields ?? []) {
      let name = custom.name || 'Unnamed field';
      if (generatedFields.has(name)) name = `Bitwarden field:${name}`;
      const base = name;
      let suffix = 2;
      while (Object.hasOwn(fields, name)) name = `${base} (${suffix++})`;
      fields[name] = custom.value ?? '';
    }
    const binaries: { name: string; data: Buffer }[] = [];
    const names = new Set<string>();
    const metadata: Record<string, unknown>[] = [];
    const itemDownloads = downloads.filter(download => download.itemId === item.id);
    for (const download of itemDownloads) {
      const key = `${item.id}:${download.id}`;
      if (expectedDownloads.has(key)) throw new Error('Duplicate downloaded attachment ID');
      expectedDownloads.add(key);
      let name = download.fileName || 'attachment';
      if (names.has(name)) name = `${name} [${download.id}]`;
      const base = name;
      let suffix = 2;
      while (names.has(name)) name = `${base} (${suffix++})`;
      names.add(name);
      metadata.push({ id: download.id, originalName: download.fileName, storedName: name, size: download.data.length, sha256: sha256(download.data) });
      binaries.push({ name, data: download.data });
    }
    // Keep metadata in recovery JSON, avoiding collisions with user custom properties.
    if (metadata.length) {
      let name = 'bw2kbdx-attachments.json';
      while (names.has(name)) name = `_${name}`;
      binaries.push({ name, data: Buffer.from(JSON.stringify(metadata)) });
    }
    addEntry(fields, item.folderId ? groupIds.get(item.folderId)! : rootUuid,
      timestamp(item.creationDate), timestamp(item.revisionDate), binaries, uuid(`item:${item.id}`), parent);
  }
  if (expectedDownloads.size !== downloads.length) throw new Error('Downloaded attachment has no matching personal item');
  const recovery = e('Group', '', [e('UUID', recoveryUuid), e('Name', 'bw2kbdx recovery'), times(defaultTime, defaultTime)]);
  root.children.push(recovery);
  addEntry({ Title: 'Original Bitwarden export', UserName: '', Password: '', URL: '', Notes: 'Unmodified JSON export for recovery; attachment files are stored on their entries.' },
    recoveryUuid, undefined, undefined, [{ name: 'bitwarden.json', data: Buffer.from(rawJson) }], uuid('bw2kbdx:source-entry'), recovery);
  const document = e('KeePassFile', '', [e('Meta', '', [
    e('Generator', 'bw2kbdx'), e('DatabaseName', 'Bitwarden backup'), e('RecycleBinEnabled', 'False'),
    e('MemoryProtection', '', [e('ProtectPassword', 'True')]), e('Binaries', '', binaryPool),
  ]), e('Root', '', [root])]);
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(document)}`, entries, groups: groupNames, itemCount: vault.items.length, attachmentCount: downloads.length };
}

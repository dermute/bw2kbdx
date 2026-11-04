import type { Vault, Download } from '../src/model.ts';

export function fixture(): { vault: Vault; downloads: Download[]; raw: string } {
  const vault: Vault = {
    encrypted: false,
    folders: [{ id: 'folder-1', name: 'Work / <重要> & personal' }, { id: 'folder-2', name: 'Work / <重要> & personal' }],
    items: [{
      id: 'login-1', type: 1, name: 'Example <&> "🔐"', folderId: 'folder-1',
      creationDate: '2024-01-02T03:04:05.123Z', revisionDate: '2026-02-03T04:05:06Z',
      notes: 'First line\r\nSecond line & <tag>\tend', favorite: true,
      login: { username: 'alice@example.test', password: 'synthetic-secret<&"\r\n🔐', totp: 'JBSWY3DPEHPK3PXP',
        uris: [{ uri: null }, { uri: 'https://example.test/?x=1&y=2', match: 0 },
          { uri: 'https://other.example.test/login', match: 3 }, { uri: 'androidapp://org.example.app', match: 2 }],
        fido2Credentials: [{ credentialId: 'synthetic-passkey', keyValue: 'not-a-real-key' }],
      },
      fields: [{ name: 'Password', value: 'separate-custom-value', type: 1 },
        { name: 'KP2A_URL_1', value: 'original-custom-url-field', type: 0 },
        { name: 'duplicate', value: 'one', type: 0 }, { name: 'duplicate', value: 'two', type: 1 },
        { name: '__proto__', value: 'literal-property', type: 0 },
        { name: 'Bitwarden.ID', value: 'user-custom-id', type: 0 }],
    },
    { id: 'note-1', type: 2, name: 'Same name', notes: 'Notes only', secureNote: { type: 0 } },
    { id: 'card-1', type: 3, name: 'Same name', folderId: 'folder-2', card: { number: '4111111111111111', code: '123', expMonth: '12', expYear: '2030' } },
    { id: 'identity-1', type: 4, name: 'Identity', identity: { firstName: 'Alice', lastName: 'Example', ssn: 'synthetic' } },
    { id: 'ssh-1', type: 5, name: 'SSH', sshKey: { privateKey: 'synthetic-private-key', publicKey: 'synthetic-public-key' } },
    { id: 'future-1', type: 99, name: 'Future type', futureField: { preserved: true } }],
  };
  const downloads: Download[] = [
    { itemId: 'login-1', id: 'attachment-1', fileName: '../same-name.bin', data: Buffer.from([0, 1, 255, 128, 13, 10]) },
    { itemId: 'login-1', id: 'attachment-2', fileName: '../same-name.bin', data: Buffer.from('second content') },
    { itemId: 'login-1', id: 'attachment-3', fileName: 'bw2kbdx-attachments.json', data: Buffer.alloc(0) },
  ];
  return { vault, downloads, raw: JSON.stringify(vault, null, 2) };
}

/** Synthetic public header for orchestration tests, NOT an encrypted database. */
export function fakeHeader(): Buffer {
  const signature = Buffer.from('03d9a29a67fb4bb500000400', 'hex');
  function field(id: number, data: Buffer): Buffer {
    const header = Buffer.alloc(5); header[0] = id; header.writeUInt32LE(data.length, 1);
    return Buffer.concat([header, data]);
  }
  function variant(type: number, key: string, value: Buffer): Buffer {
    const keyBytes = Buffer.from(key);
    const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(keyBytes.length, 1);
    const size = Buffer.alloc(4); size.writeUInt32LE(value.length);
    return Buffer.concat([header, keyBytes, size, value]);
  }
  const rounds = Buffer.alloc(8); rounds.writeBigUInt64LE(1000000n);
  return Buffer.concat([signature,
    field(2, Buffer.from('31c1f2e6bf714350be5805216afc5aff', 'hex')),
    field(11, Buffer.concat([Buffer.from([0, 1]), variant(0x42, '$UUID', Buffer.from('c9d9f39a628a4460bf740d08c18a4fea', 'hex')),
      variant(0x05, 'R', rounds), Buffer.from([0])])), field(0, Buffer.from('\r\n\r\n'))]);
}

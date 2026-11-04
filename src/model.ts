export interface Uri { uri: string | null; match?: number | null }
export interface Attachment { id: string; fileName: string; size?: string | number }
export interface Item {
  id: string;
  organizationId?: string | null;
  deletedDate?: string | null;
  folderId?: string | null;
  type: number;
  name: string;
  notes?: string | null;
  favorite?: boolean;
  creationDate?: string | null;
  revisionDate?: string | null;
  login?: { username?: string | null; password?: string | null; uris?: Uri[]; totp?: string | null; [key: string]: unknown };
  fields?: { name: string | null; value: string | null; type: number; linkedId?: number | null }[];
  attachments?: Attachment[];
  [key: string]: unknown;
}
export interface Vault { encrypted?: boolean; folders: { id: string; name: string }[]; items: Item[]; [key: string]: unknown }
export interface Download { itemId: string; id: string; fileName: string; data: Buffer }
export interface ManifestEntry {
  uuid: string;
  fields: Record<string, string>;
  attachments: Record<string, string>;
  folder: string;
  created?: string;
  modified?: string;
}
export interface Conversion { xml: string; entries: ManifestEntry[]; groups: Record<string, string>; itemCount: number; attachmentCount: number }

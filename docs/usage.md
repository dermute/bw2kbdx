# Usage and recovery

## Server connections

Set `BW_SERVER` in `.env` to your Vaultwarden HTTPS URL. Bitwarden US uses
`https://vault.bitwarden.com`; Europe uses `https://vault.bitwarden.eu`.
A server path prefix is supported. For another Docker container, use a shared
network and its network name; `localhost` refers to the backup container itself.
The official Bitwarden CLI requires HTTPS, including on shared Docker networks.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `BW_SERVER` | `https://vault.bitwarden.com`; Bitwarden-compatible HTTPS base URL |
| `BW_CLIENTID` | Personal API client ID, required |
| `BW_CLIENTSECRET` | Personal API client secret, required |
| `BW_PASSWORD` | Master password, required |
| `KDBX_PASSWORD` | Fixed backup password, required |
| `BACKUP_DIR` | `/backups`; output directory inside the container |
| `BACKUP_UID`, `BACKUP_GID` | Compose-only settings; default `1000:1000` |

Each credential/password also accepts a `_FILE` variable. Set exactly one of
the direct value or its file alternative. The Compose example loads `.env`.
File-based secrets are optional: configure `_FILE` paths and mount those files
when you prefer that deployment style.
One final newline is removed from secret files; intentional spaces are kept.
Empty secrets, embedded newlines, and NUL characters are rejected.

The output directory must already exist and be writable by the configured user.
The database has mode `0600`; scratch directories have mode `0700`. Run with a
read-only root filesystem and a **tmpfs at `/tmp`**, as in `compose.yaml`. The
program refuses non-tmpfs scratch storage. tmpfs may be swapped by the host;
configure host swap appropriately for your environment.

The official Bitwarden binary may load bundled native components from temporary
storage, so the example tmpfs permits execution. Plaintext XML and CLI state are
removed on normal exit. `docker compose run --rm` also removes the container
after a crash or forced termination. No persistent CLI session is needed.

Vault/attachment data is held in memory and temporarily represented as base64
XML. Allow several times the total decrypted attachment size in container RAM,
plus the Bitwarden CLI and KeePassXC overhead. The example allocates a 512 MiB
tmpfs; increase it for larger vaults. Each subprocess has a five-minute timeout
and a 512 MiB stdout limit. Exceeding either fails the backup without replacement.
Credentials and raw subprocess diagnostics are never logged.

## What is preserved

- Logins, secure notes, cards, identities, SSH keys, and unknown future item types.
  Standard login fields are native KeePass fields. Structured card/identity/SSH
  details are JSON in custom properties; original source data is also retained.
- Source folder names and membership. A folder name containing `/` remains one
  folder name; duplicate folder names remain separate groups.
- All nonempty login URLs, in source order: the first becomes `URL`, the rest
  become `KP2A_URL_1`, `KP2A_URL_2`, etc., matching KeePassXC's convention.
- Custom fields, including duplicates and collisions with generated fields.
  Collision names gain a prefix or numeric suffix; source JSON retains originals.
- TOTP seeds. Base32 seeds and `otpauth://` URIs also populate KeePassXC's `otp`
  field. Nonstandard seeds remain in `Bitwarden.TOTP` and the source export.
- Available creation/modification timestamps, at whole-second precision.
- Attachments on their corresponding entries, including binary and empty files.
  Duplicate filenames gain collision-safe suffixes. An attachment metadata file
  records source IDs, original names, stored names, sizes, and SHA-256 hashes.
- The **unmodified JSON export**, attached to the `Original Bitwarden export`
  entry in the `bw2kbdx recovery` group. This preserves URI matching rules,
  passkey material, password history, linked-field metadata, and other fields
  without native mappings. Preserved passkeys are not promised to work natively
  in KeePassXC; restore the source JSON to a compatible manager when appropriate.

This is a personal-vault export, not an instance-level backup. It excludes
organization-owned items, trash, Sends, account settings, and server data.
It can only preserve what the official CLI exports or makes downloadable.
SSO-only accounts without a master password are outside the supported login flow.
The export and attachment inventory use one local synced CLI state; attachment
downloads are not a server-wide transaction. A changed or unavailable attachment
causes failure rather than a knowingly incomplete replacement.

## Encryption and failure behavior

The stock KeePassXC 2.8.0 XML-import command uses **AES-KDF**, not Argon2id, and
does not expose a KDF-selection option. We request a one-second KDF calibration
and use **AES-256 with KDBX 4**, including authenticated encrypted data. A small
group metadata marker requires the KDBX 4 format. The public header is checked
before publishing. bw2kbdx implements no database encryption itself.

Only a fully reopened and verified database replaces `/backups/backup.kdbx`.
Authentication, network, export, download, conversion, verification, or output
errors return exit code `1` and leave the previous backup in place. Success
returns `0` and logs only stages and counts. Unsupported XML control characters
fail conversion rather than silently altering data. An empty source vault is a
valid backup and will replace the previous file after successful verification.

There is **one current backup**, without built-in history or retention. Use a
host backup tool if you also want historical copies. Do not overlap runs that
write the same destination; use either scheduler below.

## Recovery

Open the KDBX directly in KeePassXC to read passwords, URLs, notes, custom fields,
and attachments without a running Bitwarden server. To restore into Bitwarden,
extract `bitwarden.json` from the recovery entry and import it using the
Bitwarden JSON format. Restore attachments separately, using their source-item
and attachment metadata. Source policies or format changes can affect import;
test recovery with a dedicated account before relying on the backup.

## Monitoring scheduled runs

Check the command exit status, scheduler logs, and age of `backups/backup.kdbx`.
Alert when a run fails or the file becomes stale. Avoid overlapping jobs writing
the same output; the README examples use `flock` or a systemd oneshot service.

# Validation

The public repository is https://github.com/dermute/bw2kbdx. CI and release
publication use Ubuntu 26.04 runner hosts; the image itself also uses Ubuntu
26.04 with Node.js 24.22.2.

## Local checks

- 18 wrapper tests pass, covering conversion, multiple URLs, field collisions,
  attachment bytes, timestamps, source JSON, configuration, subprocess errors,
  cancellation, and retention of the previous backup after failure.
- Deployment and workflow YAML parses successfully. Shell scripts and the
  independent Python reader pass syntax checks.
- Native ARM64 production, test, and corresponding-source container targets
  build successfully with Ubuntu 26.04 and the pinned upstream CLIs.
- All 20 tests pass inside the locally built container, with no skipped tests.
  This includes real KeePassXC round trips and colliding entry/folder paths.
- The independent PyKeePass reader opens the resulting KDBX and verifies exact
  passwords, CRLF content, URLs, binary attachments, and the original JSON.
- The complete disposable Vaultwarden 1.37.5 test passes over HTTPS: registration,
  API-key login, unlock, import, sync, attachment upload/download, four-item backup
  with two attachments, multiple URLs, and retention after an incorrect master
  password.
- Docker Compose itself verifies that the `.env` setup passes literal dollars,
  hashes, embedded quotes, and intentional spaces into a running container.
- The source export's checksums pass. Runtime smoke checks confirm Ubuntu 26.04,
  Node.js 24.22.2, KeePassXC 2.8.0, Bitwarden CLI 2026.10.1, and non-root execution.
  The ARM64 runtime is approximately 470 MiB uncompressed.

The host provides ARM64 execution; amd64 requires the native CI runner. Local wrapper tests use cached Node.js
22.23.3 with `node --experimental-test-isolation=none --test test/*.test.ts`.
The container suite uses the pinned Node.js 24 runtime and real upstream CLIs.

## Required container checks

The [CI workflow](https://github.com/dermute/bw2kbdx/actions/workflows/ci.yml)
runs these checks on native amd64 and arm64 runners:

- Build the test and runtime images.
- Import synthetic data through KeePassXC, reopen KDBX4, verify fields and
  attachment hashes, and reject an incorrect backup password.
- Verify colliding entry/folder paths without modifying the final database.
- Open the generated database with the independent PyKeePass reader.
- Seed a disposable Vaultwarden vault with multiple URLs and duplicate attachment
  filenames, run the complete backup, and confirm an incorrect master password
  leaves the previous backup intact.
- Assert Ubuntu 26.04, Node.js 24, non-root execution, CLI versions, and record
  the uncompressed runtime image size.

KeePassXC 2.8's KDBX4 plaintext XML export omits binary attachment data. Runtime
verification therefore exports attachments separately through its CLI and
compares their SHA-256 hashes. Ambiguous entry paths use a temporary database
copy so duplicate names can be verified without changing the final backup.
Bitwarden attachment metadata reports encrypted file size, not plaintext length;
the official CLI authenticates downloads before their plaintext hashes are checked.

## Remaining external validation

Live Bitwarden compatibility requires a dedicated test account and has not
been verified. Disposable Vaultwarden coverage must not be presented as a live
Bitwarden test.

The release workflow publishes corresponding source archives before the GHCR
image, then verifies anonymous image access. Source publication and public GHCR
access must both succeed before publication is considered complete.

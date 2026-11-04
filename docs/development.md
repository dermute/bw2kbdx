# Development, testing, and releases

Requires Node.js 22.18+; CI and the image use pinned Node.js 24. TypeScript runs
with Node's native type stripping. There are **no npm dependencies** in the
wrapper; `package-lock.json` records that empty dependency graph.

```sh
npm ci --ignore-scripts
npm test
# Requires keepassxc-cli on PATH:
npm run test:integration
# Complete container suite, including the real KDBX implementation:
docker build --target test -t bw2kbdx:test .
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m bw2kbdx:test
```

CI runs synthetic conversion/failure tests, real KeePassXC round trips, an
independent PyKeePass reader, and a seeded disposable Vaultwarden integration
on native amd64 and arm64 runners. PyKeePass is only a test dependency.
The CI workflow runs on pushes and pull requests and can also be started from
GitHub's Actions tab using **Run workflow**.

Build and runtime stages use **`ubuntu:26.04`** with pinned **Node.js 24.22.2**.
The Node binary and its license are copied from the official Node distribution
image; npm, Yarn, and that image's Debian filesystem are not included. The
container runs as UID/GID `1000:1000` by default, overridable through Compose.
GitHub Actions uses Ubuntu 26.04 runner hosts for unit tests, native amd64/arm64
container tests, and release publication.

The Docker build compiles just KeePassXC's CLI target against Ubuntu's Qt 6 and
Botan 3 libraries and copies its required shared libraries. It downloads
checksummed official **OSS** Bitwarden CLI binaries, which include their own Node
runtime; this trades some image size for
using upstream release artifacts and avoiding mutable npm dependencies. CI
records uncompressed image sizes for both architectures.

To release, update the package versions and Compose image tag together, commit,
and push a matching `vX.Y.Z` tag. Tests must pass before publication. The workflow
publishes corresponding source archives to GitHub Releases, then builds the
multiarchitecture image with SBOM/provenance and tags `X.Y.Z` and `latest`.
Use Conventional Commits and include `Co-authored-by: Codex <codex@openai.com>`
on commits assisted by Codex.

The first GHCR package may default to private: set its package visibility to
**public** in GitHub package settings if the anonymous-access check fails.
Subsequent releases retain that visibility. No private-registry credentials
should be needed by users pulling the public image.

Original project code is MIT. Bundled tools retain their own licenses; see
[third-party notices](../THIRD_PARTY_NOTICES.md) and each release's corresponding
source bundle.

## Before pushing

Build and test the container locally before pushing changes. On an ARM64 host
using Podman, pass `--build-arg TARGETARCH=arm64`; use `amd64` on x86-64.
Docker BuildKit supplies this argument automatically. Keep the runtime non-root
and use the read-only filesystem and tmpfs options shown above.

See [validation results and integration coverage](../VALIDATION.md) and the
[CI workflow](../.github/workflows/ci.yml) for the complete disposable Vaultwarden
and independent-reader checks. No real vault credentials belong in tests or CI.

The [header image brief](header-image.md) records how the README artwork was generated.

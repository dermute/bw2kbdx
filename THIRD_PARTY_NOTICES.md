# Third-party software in the container

The MIT license covers bw2kbdx's original code. It does not relicense its tools.

- **KeePassXC 2.8.0**: GPL version 2 or version 3, plus the component licenses
  listed in its `COPYING` file. We build the unmodified `keepassxc-cli` target.
  Its license files are installed in `/usr/share/bw2kbdx/keepassxc`.
  Source: https://github.com/keepassxreboot/keepassxc/releases/tag/2.8.0
- **Bitwarden CLI 2026.10.1, OSS distribution**: GPL-3.0 for the open source
  client, with component licenses described in the upstream sources. We bundle
  the official `bw-oss-linux` or `bw-oss-linux-arm64` binary, not the commercial
  distribution. License files are in `/usr/share/bw2kbdx/bitwarden`.
  Source: https://github.com/bitwarden/clients/tree/cli-v2026.10.1
- **Node.js 24.22.2**: MIT with bundled dependency notices. The binary and license
  are copied from the official Node image into the Ubuntu 26.04 base. See
  `/usr/local/LICENSE` and https://github.com/nodejs/node for source and notices.
- **Ubuntu 26.04 runtime libraries**: individual licenses, including Qt (LGPL/GPL),
  Botan (BSD), and readline (GPL). Copyright notices for copied runtime libraries
  are installed in `/usr/share/bw2kbdx/ubuntu`. Source packages are available from
  the Ubuntu package archives: https://archive.ubuntu.com/ubuntu/pool/

GitHub Releases provide bw2kbdx's own source through GitHub's automatically
generated ZIP and tar.gz downloads and link to the versioned container image
at `ghcr.io/dermute/bw2kbdx`. Third-party source archives are not attached to
project releases; the upstream sources are linked above.

For local inspection of upstream build inputs, the optional `sources` target
exports the KeePassXC and Bitwarden sources, Node source, Ubuntu library source
packages, checksums, notices, and build instructions:

```sh
docker build --target sources --output type=local,dest=release-source .
tar -czf corresponding-source.tar.gz -C release-source .
```

Project releases: https://github.com/dermute/bw2kbdx/releases

The test image additionally uses PyKeePass (GPL-3.0) as an independent reader.
It is not shipped in the runtime image.

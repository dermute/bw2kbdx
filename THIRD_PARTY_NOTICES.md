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
  Botan (BSD), and readline (GPL). The release source bundle includes the Ubuntu
  source packages and installed copyright notices for copied runtime libraries.

Every published release must include `corresponding-source.tar.gz` alongside
the binary container. This bundle contains the KeePassXC and Bitwarden source
archives, Node source, Ubuntu library source packages, checksums, this notice,
and the Dockerfile with the build procedure. It is generated in CI from the
same build stages as the container. Do not publish an image without that bundle.

Build the source bundle locally with:

```sh
docker build --target sources --output type=local,dest=release-source .
tar -czf corresponding-source.tar.gz -C release-source .
```

Release source bundles: https://github.com/dermute/bw2kbdx/releases

The test image additionally uses PyKeePass (GPL-3.0) as an independent reader.
It is not shipped in the runtime image.

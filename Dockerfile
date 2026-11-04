# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24.22.2
# Use the official image only as a source of the portable Node binary and license.
# Build tools, KeePassXC libraries, and the final filesystem all come from Ubuntu.
FROM node:${NODE_VERSION}-bookworm-slim AS node-distribution

FROM ubuntu:26.04 AS base
ARG NODE_VERSION
ENV NODE_VERSION=${NODE_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-distribution /usr/local/bin/node /usr/local/bin/node
COPY --from=node-distribution /usr/local/LICENSE /usr/local/LICENSE
RUN node --version

FROM base AS keepassxc-build
ARG KEEPASSXC_VERSION=2.8.0
ARG KEEPASSXC_SHA256=4ed4b77d375f021fc04648c257fedfb41dc13c6bd5c4965d8ded31284c9c653c
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential cmake ninja-build pkg-config \
    qt6-base-dev qt6-tools-dev qt6-tools-dev-tools qt6-l10n-tools qt6-svg-dev \
    libbotan-3-dev libminizip-dev libpcsclite-dev libusb-1.0-0-dev libkeyutils-dev \
    libzxcvbn-dev libreadline-dev libgpg-error-dev libxkbcommon-dev libqrencode-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN mkdir /sources && curl -fsSL --retry 3 \
    "https://github.com/keepassxreboot/keepassxc/releases/download/${KEEPASSXC_VERSION}/keepassxc-${KEEPASSXC_VERSION}-src.tar.xz" \
    -o /sources/keepassxc.tar.xz \
    && echo "${KEEPASSXC_SHA256}  /sources/keepassxc.tar.xz" | sha256sum -c - \
    && mkdir keepassxc && tar -xJf /sources/keepassxc.tar.xz --strip-components=1 -C keepassxc \
    && cmake -S keepassxc -B out -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel \
       -DWITH_TESTS=OFF -DWITH_GUI_TESTS=OFF -DWITH_X11=OFF -DKPXC_MINIMAL=ON \
       -DKPXC_FEATURE_NETWORK=OFF -DKPXC_FEATURE_UPDATES=OFF -DKPXC_FEATURE_DOCS=OFF \
    && cmake --build out --target keepassxc-cli --parallel 2 \
    && strip out/src/cli/keepassxc-cli \
    && mkdir -p /runtime/usr/local/bin /runtime/usr/share/bw2kbdx/keepassxc \
    && cp out/src/cli/keepassxc-cli /runtime/usr/local/bin/ \
    && cp keepassxc/COPYING keepassxc/LICENSE* /runtime/usr/share/bw2kbdx/keepassxc/
COPY scripts/copy-runtime.sh /build/copy-runtime.sh
RUN sh /build/copy-runtime.sh out/src/cli/keepassxc-cli

# Use checksummed official OSS releases, including arm64. No mutable npm dependencies.
FROM keepassxc-build AS bitwarden-build
ARG TARGETARCH
ARG BITWARDEN_VERSION=2026.10.1
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) archive="bw-oss-linux-${BITWARDEN_VERSION}.zip"; digest=53384064abe7555039281bc2e6fe51846368ba60db9b7ba89de183409d7f6738 ;; \
      arm64) archive="bw-oss-linux-arm64-${BITWARDEN_VERSION}.zip"; digest=9413e412ba2f8d3b179c54314c3d2d51c0b2ec25ed17b96a98b7c2d404b6d2a7 ;; \
      *) exit 1 ;; \
    esac \
    && curl -fsSL --retry 3 "https://github.com/bitwarden/clients/releases/download/cli-v${BITWARDEN_VERSION}/${archive}" -o /build/bw.zip \
    && echo "$digest  /build/bw.zip" | sha256sum -c - \
    && unzip /build/bw.zip -d /build/bw-release \
    && install -m 0755 /build/bw-release/bw /runtime/usr/local/bin/bw \
    && mkdir -p /runtime/usr/share/bw2kbdx/bitwarden \
    && curl -fsSL --retry 3 "https://github.com/bitwarden/clients/archive/refs/tags/cli-v${BITWARDEN_VERSION}.tar.gz" -o /sources/bitwarden-clients.tar.gz \
    && tar -xzf /sources/bitwarden-clients.tar.gz --wildcards --strip-components=1 -C /runtime/usr/share/bw2kbdx/bitwarden '*/LICENSE*.txt' \
    && sha256sum /sources/* > /sources/SHA256SUMS

# Optional local source export for inspecting upstream build inputs.
# GitHub Releases use the project's own source archives and link to the image.
FROM bitwarden-build AS source-build
COPY scripts/collect-sources.sh /build/collect-sources.sh
RUN sh /build/collect-sources.sh

FROM scratch AS sources
COPY --from=source-build /sources/ /sources/
COPY Dockerfile THIRD_PARTY_NOTICES.md /sources/
COPY scripts/ /sources/scripts/
COPY src/ /sources/src/
COPY package.json package-lock.json LICENSE /sources/

FROM base AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="bw2kbdx" \
      org.opencontainers.image.description="Bitwarden/Vaultwarden personal-vault backups via KeePassXC XML import" \
      org.opencontainers.image.source="https://github.com/dermute/bw2kbdx" \
      org.opencontainers.image.url="https://github.com/dermute/bw2kbdx" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN mkdir -p /backups /app && chown 1000:1000 /backups
COPY --from=bitwarden-build /runtime/ /
COPY --chown=1000:1000 package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md /app/
COPY --chown=1000:1000 src/ /app/src/
WORKDIR /app
ENV NODE_ENV=production
USER 1000:1000
ENTRYPOINT ["node", "/app/src/main.ts"]
CMD []

# CI target retains tools/tests; none of these are included in the runtime image.
FROM runtime AS test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/verify \
    && /opt/verify/bin/pip install --no-cache-dir pykeepass==4.2.0
COPY test/ /app/test/
USER 1000:1000
ENV REQUIRE_KEEPASSXC=1
ENTRYPOINT ["node", "--test"]
CMD ["test/convert.test.ts", "test/config-process.test.ts", "test/backup.test.ts", "test/keepassxc.test.ts"]

FROM runtime AS final

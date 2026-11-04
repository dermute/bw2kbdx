#!/bin/sh
set -eu

# Ubuntu 26.04 uses deb822 sources. Download exact source-package versions
# for every library copied with the CLI, retaining their copyright notices too.
sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/ubuntu.sources
apt-get update
mkdir -p /sources/ubuntu /sources/copyright
libraries=$(ldd /runtime/usr/local/bin/keepassxc-cli)
printf '%s\n' "$libraries" \
  | awk '/=> \/|^[[:space:]]*\// { for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i }' > /sources/runtime-libraries.txt
while IFS= read -r library; do
  resolved=$(readlink -f "$library")
  owner=$(dpkg-query -S "$resolved" 2>/dev/null \
    || dpkg-query -S "$library" 2>/dev/null \
    || dpkg-query -S "${resolved#/usr}" 2>/dev/null)
  package=$(printf '%s\n' "$owner" | head -n 1 | sed 's/: \/.*//')
  dpkg-query -W -f='${source:Package}=${source:Version}\n' "$package"
  doc_package=$(printf '%s' "$package" | cut -d: -f1)
  if [ -f "/usr/share/doc/$doc_package/copyright" ]; then
    cp "/usr/share/doc/$doc_package/copyright" "/sources/copyright/$doc_package"
  fi
done < /sources/runtime-libraries.txt > /sources/ubuntu-source-packages.unsorted
sort -u /sources/ubuntu-source-packages.unsorted > /sources/ubuntu-source-packages.txt
rm /sources/ubuntu-source-packages.unsorted
cd /sources/ubuntu
while IFS= read -r package; do apt-get source --download-only "$package"; done < /sources/ubuntu-source-packages.txt
cd /sources
curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.xz" -o node.tar.xz
cp /usr/local/LICENSE node-LICENSE
dpkg-query -W > build-packages.txt
find . -type f ! -name SHA256SUMS -exec sha256sum '{}' + > SHA256SUMS

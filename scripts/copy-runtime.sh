#!/bin/sh
set -eu
libraries=$(ldd "$1")
printf '%s\n' "$libraries" | awk '/=> \/|^[[:space:]]*\// { for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i }' \
  | while IFS= read -r library; do
      resolved=$(readlink -f "$library")
      # Preserve the loader's library filename, but normalize /lib -> /usr/lib
      # directories so the runtime copy does not overwrite Ubuntu's directory links.
      directory=$(readlink -f "$(dirname "$library")")
      mkdir -p "/runtime$directory"
      cp -L "$library" "/runtime$directory/$(basename "$library")"
      # Ubuntu's package database can retain pre-usrmerge paths for these files.
      owner=$(dpkg-query -S "$resolved" 2>/dev/null \
        || dpkg-query -S "$library" 2>/dev/null \
        || dpkg-query -S "${resolved#/usr}" 2>/dev/null)
      package=$(printf '%s\n' "$owner" | head -n 1 | sed 's/: \/.*//')
      doc_package=$(printf '%s' "$package" | cut -d: -f1)
      # Some Ubuntu /usr/share/doc entries are symlinks already present in base.
      # Keep notices in our own directory instead of copying over those links.
      mkdir -p /runtime/usr/share/bw2kbdx/ubuntu
      cp "/usr/share/doc/$doc_package/copyright" "/runtime/usr/share/bw2kbdx/ubuntu/$doc_package.copyright"
    done

#!/usr/bin/env bash
# Fail when the AppImage needs a newer glibc than the AppImage catalog's
# ubuntu-22.04 test runner has (AppImage/appimage.github.io#10467).
# Usage: scripts/check-appimage-glibc.sh path/to/Fidget.AppImage

set -euo pipefail

max_glibc=2.35

appimage="$(realpath "$1")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && "$appimage" --appimage-extract > /dev/null)
root="$work/squashfs-root"

status=0
while IFS= read -r -d '' f; do
  # Non-ELF files make objdump fail and yield no version.
  need="$(objdump -T "$f" 2> /dev/null | grep -o 'GLIBC_[0-9.]*' | cut -d_ -f2 | sort -uV | tail -n 1 || true)"
  [ -n "$need" ] || continue
  if [ "$(printf '%s\n' "$max_glibc" "$need" | sort -V | tail -n 1)" != "$max_glibc" ]; then
    echo "::error::${f#"$root"/} needs GLIBC_$need, above $max_glibc"
    status=1
  fi
done < <(find "$root/usr/bin/fidget" "$root/usr/lib" -type f -print0)

[ "$status" -eq 0 ] && echo "Every ELF in usr/bin/fidget and usr/lib needs GLIBC $max_glibc or older"
exit "$status"

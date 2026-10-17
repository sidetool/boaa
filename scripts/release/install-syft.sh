#!/bin/sh
set -eu
version=1.54.1
case "$(uname -m)" in
  x86_64) architecture=amd64; checksum=c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47 ;;
  aarch64) architecture=arm64; checksum=dfdf0537610113edbefe1f1fc6548bc957b2d77439636ec824fcf0e10d46d054 ;;
  *) exit 1 ;;
esac
archive="syft_${version}_linux_${architecture}.tar.gz"
curl --fail --location --retry 4 "https://github.com/anchore/syft/releases/download/v${version}/${archive}" -o "/tmp/$archive"
printf '%s  %s\n' "$checksum" "/tmp/$archive" | sha256sum -c -
tar -xzf "/tmp/$archive" -C /usr/local/bin syft
rm "/tmp/$archive"

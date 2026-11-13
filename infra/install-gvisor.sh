#!/usr/bin/env bash
# Installs gVisor (runsc) at a pinned release and tells Docker about it. The
# browser that opens generated apps runs under it and under nothing else: it is
# the wall around the one place where generated code runs on the server.
# Docker is reloaded, not restarted, so running containers are left alone.
# Does nothing when this release is already in place.
# Usage: sudo ./install-gvisor.sh
set -euo pipefail

release=20261102
# SHA-512 of gvisor.tar.zstd for x86_64, as published next to it on 2026-11-13.
sha512=3c400f72be459b57b99b1c4f69be96bcd67eef3caf2078e595fc98e688b6b9a3af7802646b3dde7da8a9aba96d34f86be303e0430c7868ab2d13becdd403c0c1
bin=/usr/local/bin

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo "the pinned checksum is for x86_64" >&2; exit 1; }

known() { docker info --format '{{range $name, $runtime := .Runtimes}}{{$name}} {{end}}' | grep --quiet --word-regexp runsc; }
if [[ $("$bin/runsc" --version 2>/dev/null | head -1) == "runsc version release-$release.0" ]] && known; then
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --max-time 300 --output "$tmp/gvisor.tar.zstd" \
  "https://storage.googleapis.com/gvisor/releases/release/$release/x86_64/gvisor.tar.zstd"
echo "$sha512  $tmp/gvisor.tar.zstd" | sha512sum --check --quiet -
mkdir "$tmp/out"
tar --zstd --extract --file "$tmp/gvisor.tar.zstd" --directory "$tmp/out"

# runsc looks for its helpers in gvisor-bin/ next to itself.
install -o root -g root -m 755 "$tmp/out/runsc" "$bin/runsc"
rm -rf "$bin/gvisor-bin"
install -d -o root -g root -m 755 "$bin/gvisor-bin"
install -o root -g root -m 755 "$tmp/out"/gvisor-bin/* "$bin/gvisor-bin/"

"$bin/runsc" install
systemctl reload docker
sleep 2
known || { echo "Docker does not know the runsc runtime" >&2; exit 1; }
echo "gVisor $release is installed"

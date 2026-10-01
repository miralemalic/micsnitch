#!/bin/bash
# Runs the real extension in a hidden GNOME Shell inside a test container,
# with a private audio stack. Your desktop is never involved.
#   tests/popup.sh fedora44 [OUTDIR]
# debian13 has GNOME 48, fedora43 49, fedora44 50 and fedora45 51.
# Results and the Shell's log end up in OUTDIR (default: shots/DISTRO).
set -euo pipefail
cd "$(dirname "$0")/.."

distro=${1:?distro, e.g. fedora44}
out=${2:-shots/$distro}
mkdir -p "$out"
OUT=$out TIMEOUT=600 tests/container.sh "$distro-gnome" tests/gnome.sh | tee "$out/results.txt"

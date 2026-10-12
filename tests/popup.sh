#!/bin/bash
# Runs the real popup inside a test container with a private audio stack:
# the extension in a hidden GNOME Shell, or the KDE app on a hidden KWin.
# Your desktop is never involved.
#   tests/popup.sh fedora44 [OUTDIR]       GNOME
#   tests/popup.sh fedora44-kde [OUTDIR]   KDE Plasma
# debian13 has GNOME 48, fedora43 49, fedora44 50 and fedora45 51.
# Results and the Shell's log end up in OUTDIR (default: shots/DISTRO).
set -euo pipefail
cd "$(dirname "$0")/.."

distro=${1:?distro, e.g. fedora44, or fedora44-kde for the KDE app}
out=${2:-shots/$distro}
mkdir -p "$out"
case $distro in
    *-kde) OUT=$out TIMEOUT=600 tests/container.sh "$distro" tests/kde.sh ;;
    *) OUT=$out TIMEOUT=600 tests/container.sh "$distro-gnome" tests/gnome.sh ;;
esac | tee "$out/results.txt"

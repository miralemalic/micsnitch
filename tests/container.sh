#!/bin/bash
# Runs a command inside a throwaway container with its own PipeWire stack.
#   tests/container.sh fedora44 tests/run.sh
# A -gnome suffix (fedora44-gnome) adds GNOME Shell to the image.
# MICSNITCH=0 runs it without the policy installed, OUT=dir is mounted at /out.
set -euo pipefail
cd "$(dirname "$0")/.."

distro=${1:?distro, e.g. fedora44}
shift
image=localhost/micsnitch-test:$distro
base=${distro%-gnome}
gnome=
[ "$base" = "$distro" ] || gnome=1

build() { podman build -q -t "$image" --build-arg GNOME="$gnome" "$@" tests/containers >/dev/null; }

if ! podman image exists "$image"; then
    case $base in
        fedora*) build -f tests/containers/fedora.Containerfile --build-arg RELEASE="${base#fedora}" ;;
        debian13) build -f tests/containers/debian.Containerfile --build-arg IMAGE=debian:trixie ;;
        ubuntu2604) build -f tests/containers/debian.Containerfile --build-arg IMAGE=ubuntu:26.04 ;;
        arch) build -f tests/containers/arch.Containerfile ;;
        *) echo "no container recipe for $distro" >&2; exit 1 ;;
    esac
fi

mounts=(-v "$PWD:/src:ro,z")
[ -z "${OUT:-}" ] || mounts+=(-v "$(realpath "$OUT"):/out:z")

exec podman run --rm --timeout "${TIMEOUT:-240}" -e MICSNITCH="${MICSNITCH:-1}" \
    "${mounts[@]}" -w /src "$image" dbus-run-session -- /src/tests/stack.sh "$@"

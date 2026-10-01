#!/bin/bash
# Runs a command inside a throwaway container with its own PipeWire stack.
#   tests/container.sh fedora44 tests/run.sh
# MICSNITCH=0 runs it without the policy installed.
set -euo pipefail
cd "$(dirname "$0")/.."

distro=${1:?distro, e.g. fedora44}
shift
image=localhost/micsnitch-test:$distro

build() { podman build -q -t "$image" "$@" tests/containers >/dev/null; }

if ! podman image exists "$image"; then
    case $distro in
        fedora*) build -f tests/containers/fedora.Containerfile --build-arg RELEASE="${distro#fedora}" ;;
        debian13) build -f tests/containers/debian.Containerfile --build-arg IMAGE=debian:trixie ;;
        ubuntu2604) build -f tests/containers/debian.Containerfile --build-arg IMAGE=ubuntu:26.04 ;;
        arch) build -f tests/containers/arch.Containerfile ;;
        *) echo "no container recipe for $distro" >&2; exit 1 ;;
    esac
fi

exec podman run --rm --timeout 240 -e MICSNITCH="${MICSNITCH:-1}" -v "$PWD:/src:ro,z" -w /src \
    "$image" dbus-run-session -- /src/tests/stack.sh "$@"

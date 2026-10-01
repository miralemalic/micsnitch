#!/bin/bash
# Starts a private PipeWire stack inside a test container, then runs "$@".
# Usage (from the host): tests/container.sh <distro> <command...>
set -euo pipefail

export XDG_RUNTIME_DIR=/tmp/run
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
cfg=${XDG_CONFIG_HOME:-$HOME/.config}
data=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$cfg/pipewire/pipewire.conf.d"
cp /src/tests/containers/fake-mic.conf "$cfg/pipewire/pipewire.conf.d/"

if [ "${MICSNITCH:-1}" = 1 ]; then
    /src/tools/install.sh --no-restart --no-extension
fi

# The link fixture is for tests only, never a real install
install -Dm644 /src/tests/containers/link-fixture.lua "$data/wireplumber/scripts/link-fixture.lua"
install -Dm644 /src/tests/containers/link-fixture.conf "$cfg/wireplumber/wireplumber.conf.d/link-fixture.conf"

wait_for() {
    for _ in $(seq 50); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
    echo "timed out waiting for: $*" >&2
    return 1
}

pipewire >/tmp/pipewire.log 2>&1 &
wait_for test -S "$XDG_RUNTIME_DIR/pipewire-0"
wireplumber >/tmp/wireplumber.log 2>&1 &
pipewire-pulse >/tmp/pipewire-pulse.log 2>&1 &
wait_for test -S "$XDG_RUNTIME_DIR/pulse/native"
wait_for sh -c 'pw-metadata -n default | grep -q default.audio.sink'
if [ "${MICSNITCH:-1}" = 1 ]; then
    wait_for sh -c 'pw-metadata -n micsnitch | grep -q micsnitch.active'
fi

"$@"

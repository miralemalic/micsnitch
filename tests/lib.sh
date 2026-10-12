# shellcheck shell=bash
# Shared helpers for a private container stack. Never source on a real session.
tone=/tmp/tone.wav

make_tone() {
    [ -f "$tone" ] && return
    python3 - "$tone" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
    samples = [int(12000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000)]
    w.writeframes(b"".join(struct.pack("<hh", v, v) for v in samples) * 60)
PY
}

feed_fake_mic() {
    make_tone
    # A restarted policy needs a fresh feeder. Two copies can cancel out.
    if [ -n "${feed_pid:-}" ]; then
        kill "$feed_pid" 2>/dev/null || true
        wait "$feed_pid" 2>/dev/null || true
    fi
    pw-cat --playback --target fake-mic.feed "$tone" >/dev/null 2>&1 &
    feed_pid=$!
    sleep 0.5
}

# Return the recorder's real status. A still-running recording ends with 124.
record() {
    rm -f "$1"
    timeout -k 1 "${3:-2}" pw-record --target "${2:-fake-mic}" --rate 48000 \
        --channels 2 --format s16 "$1" >/dev/null 2>&1
}

sound_of() {
    python3 - "$1" <<'PY'
import struct, sys, wave
try:
    with wave.open(sys.argv[1]) as w:
        if w.getsampwidth() != 2:
            raise ValueError("not a 16-bit recording")
        data = w.readframes(w.getnframes())
        peak = max((abs(v) for (v,) in struct.iter_unpack("<h", data)), default=0)
    print("sound" if peak > 1000 else "silence")
except (OSError, EOFError, ValueError, wave.Error):
    print("invalid recording")
    sys.exit(1)
PY
}

pass=0 fail=0
check() {
    if [ "$2" = "$3" ]; then echo "  ok    $1"; pass=$((pass + 1))
    else echo "  FAIL  $1 (expected $3, got $2)"; fail=$((fail + 1)); fi
}

wait_for() {
    for _ in $(seq 50); do "$@" && return 0; sleep 0.1; done
    echo "timed out waiting for: $*" >&2
    return 1
}

# A Pulse app the popup can name. Every one claims to be electron.
recorder() {
    timeout -k 1 45 parecord --client-name="$1" \
        --property=application.process.binary=electron --device=fake-mic --file-format=wav "$2"
}

# A refused or stopped recorder ends with an error, not by running out of time
expect_denied() {
    local code
    if wait "$2"; then code=0; else code=$?; fi
    case $code in 0|124|137) check "$1" "exit $code" error ;; *) check "$1" error error ;; esac
}

# Read metadata through pw-dump so quoted app names remain valid JSON.
entries() {
    pw-dump | python3 -c '
import json, sys
key, name = sys.argv[1:]
print(json.dumps([{ "id": m["subject"], "value": m["value"] }
    for o in json.load(sys.stdin) if o.get("props", {}).get("metadata.name") == name
    for m in o.get("metadata", []) if m["key"] == key]))' "$1" "${2:-micsnitch}"
}

active() { [ "$(entries micsnitch.active)" != '[]' ]; }

# Prints node-id, port-id and node:port for one matching port.
port_of() {
    pw-dump | python3 -c '
import json, sys
name, direction = sys.argv[1:]
objects = json.load(sys.stdin)
nodes = {o["id"]: o["info"]["props"].get("node.name") for o in objects
         if o["type"] == "PipeWire:Interface:Node"}
for o in objects:
    if o["type"] == "PipeWire:Interface:Port" and o["info"]["direction"] == direction:
        props = o["info"]["props"]
        if nodes.get(props.get("node.id")) == name:
            print(props["node.id"], o["id"], name + ":" + props["port.name"])
            break' "$1" "$2"
}

# Connect before running "$@", then try to create an audio link directly.
self_wire() {
    local cli on op out inn ip input
    rm -f /tmp/cli; mkfifo /tmp/cli
    timeout -k 1 10 pw-cli </tmp/cli >/dev/null 2>&1 &
    cli=$!
    exec 3>/tmp/cli
    sleep 1
    "$@"
    read -r on op out < <(port_of fake-mic output)
    read -r inn ip input < <(port_of fake-mic.feed input)
    echo "create-link $on $op $inn $ip" >&3
    sleep 0.5
    linked "$out" "$input" && echo linked || echo refused
    echo quit >&3
    exec 3>&-
    wait "$cli"
}

stop_wireplumber() {
    local p
    for p in /proc/[0-9]*; do
        [ "$(cat "$p/comm" 2>/dev/null)" = wireplumber ] && kill "${p#/proc/}"
    done
    sleep 0.5
}

start_wireplumber() {
    wireplumber >>/tmp/wireplumber.log 2>&1 &
    wait_for active
}

# Keep a client-owned sink alive for direct-link and app-sink tests.
start_app() {
    rm -f /tmp/app; mkfifo /tmp/app
    pw-cli </tmp/app >/dev/null 2>&1 &
    app=$!
    exec 4>/tmp/app
    echo "create-node adapter { factory.name = support.null-audio-sink" \
         "node.name = evil media.class = Audio/Sink audio.position = [ FL FR ] }" >&4
    sleep 0.5
}

stop_app() {
    echo quit >&4
    exec 4>&-
    wait "$app"
}

linked() {
    pw-link -l | awk -v s="$1" -v d="$2" '
        $0 == s { f = 1; next } /^[^ ]/ { f = 0 } f && index($0, d) { hit = 1 }
        END { exit !hit }'
}

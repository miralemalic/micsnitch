#!/bin/bash
# The gate's tests. They run in a container:
#   tests/container.sh fedora44 tests/run.sh
# shellcheck source=tests/lib.sh
. "$(dirname "$0")/lib.sh"

say() { pw-metadata -n micsnitch "$@" >/dev/null; }
field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$1" "$2"; }
requests() {
    entries micsnitch.request | python3 -c '
import json,sys
for e in json.load(sys.stdin):
    print(json.dumps({"id": e["id"], **e["value"]}))'
}
answer() {
    say "$(field "$1" id)" micsnitch.answer \
        "$2 ${3:-$(field "$1" serial)} $(field "$1" kind)"
}
refused() {
    case $1 in 0|124|137) echo "exit $1" ;; *) echo error ;; esac
}
seen=' '
wait_request() {
    local line token
    req=
    for _ in $(seq 50); do
        while read -r line; do
            token="$(field "$line" serial):$(field "$line" kind)"
            case $seen in *" $token "*) continue ;; esac
            seen="$seen$token "
            req=$line
            return 0
        done < <(requests)
        sleep 0.1
    done
    echo "timed out waiting for a new request" >&2
    return 1
}
recording_present() {
    entries micsnitch.recording | python3 -c '
import json,sys
sys.exit(not any(str(e["value"]["serial"]) == sys.argv[1] for e in json.load(sys.stdin)))' "$1"
}
recording_gone() { ! recording_present "$1"; }
client_connected() {
    pw-dump | python3 -c '
import json,sys
sys.exit(not any(o["type"] == "PipeWire:Interface:Client" and
    str(o.get("info", {}).get("props", {}).get("pipewire.sec.pid")) == sys.argv[1]
    for o in json.load(sys.stdin)))' "$1"
}
start_popup() {
    stdbuf -oL pw-metadata -m -n micsnitch >/tmp/watch.txt 2>&1 &
    watch=$!
    wait_for client_connected "$watch" || exit 1
    say 0 micsnitch.ui "ready $watch"
}
finish_recorder() {
    wait "$rec"
    check "$1" "$?" 124
}

feed_fake_mic
start_popup
check "the gate says it's on" \
    "$(entries micsnitch.active | python3 -c 'import json,sys; e=json.load(sys.stdin); print("live" if len(e)==1 and e[0]["id"]>0 and str(e[0]["value"])=="2" else "invalid")')" live

echo "held"
record /tmp/held.wav fake-mic 2 & rec=$!
wait_request
check "the request identifies the mic" "$(field "$req" kind)" mic
check "a waiting request isn't an active recording" "$(entries micsnitch.recording)" '[]'
finish_recorder "a held recorder waits instead of crashing"
check "a held recording contains silence" "$(sound_of /tmp/held.wav)" silence

echo "allow"
record /tmp/allow.wav fake-mic 3 & rec=$!
wait_request
answer "$req" allow 1
sleep 0.2
check "an answer for another serial is ignored" \
    "$(requests | wc -l)" 1
answer "$req" allow
wait_for recording_present "$(field "$req" serial)"
check "an allowed stream appears only after audio connects" "$?" 0
finish_recorder "an allowed recorder stays alive"
check "allow lets the sound through" "$(sound_of /tmp/allow.wav)" sound
wait_for recording_gone "$(field "$req" serial)"
check "a finished stream disappears" "$?" 0
record /tmp/again.wav fake-mic 1 & rec=$!
wait_request
check "the next recording asks again" "$([ -n "$req" ] && echo asked)" asked
finish_recorder "the next request remains held"

echo "deny"
timeout -k 1 5 pw-record --target fake-mic /tmp/deny.wav >/dev/null 2>&1 & rec=$!
wait_request
answer "$req" deny
start=$SECONDS
wait "$rec"; code=$?
check "deny stops the recorder with an error" "$(refused "$code")" error
check "deny acts immediately" "$([ $((SECONDS - start)) -lt 3 ] && echo fast || echo slow)" fast

echo "system audio and retargeting"
pactl set-default-source fake-mic.feed.monitor
timeout -k 1 12 parecord --file-format=wav /tmp/swap.wav >/dev/null 2>&1 & rec=$!
wait_request
system_req=$req
check "recording speaker audio asks" "$(field "$req" kind)" system
answer "$req" allow
wait_for recording_present "$(field "$req" serial)"
check "an approved system recording becomes active" "$?" 0
source_output=$(pactl list short source-outputs | head -1 | cut -f1)
pactl move-source-output "$source_output" fake-mic
wait_request
check "moving to the mic asks for microphone consent" "$(field "$req" kind)" mic
check "the moved recording keeps its serial" "$(field "$req" serial)" "$(field "$system_req" serial)"
answer "$system_req" allow
sleep 0.2
check "an old system answer can't approve the mic" "$(requests | wc -l)" 1
check "the unapproved mic connection isn't active" \
    "$(entries micsnitch.recording | python3 -c 'import json,sys; print("none" if all(e["value"]["kind"] != "mic" for e in json.load(sys.stdin)) else "recording")')" none
answer "$req" deny
wait "$rec"; code=$?
check "denying the new kind stops the moved recorder" "$(refused "$code")" error
pactl set-default-source fake-mic

echo "individual stop"
timeout -k 1 10 pw-record --target fake-mic /tmp/stop.wav >/dev/null 2>&1 & rec=$!
wait_request
answer "$req" allow
wait_for recording_present "$(field "$req" serial)"
stop_req=$req
record /tmp/unrelated.wav fake-mic 3 & other=$!
wait_request
answer "$req" allow
wait_for recording_present "$(field "$req" serial)"
other_serial=$(field "$req" serial)
req=$stop_req
say "$(field "$req" id)" micsnitch.stop 1
sleep 0.2
check "Stop for an old serial is ignored" "$(recording_present "$(field "$req" serial)" && echo active)" active
say "$(field "$req" id)" micsnitch.stop "$(field "$req" serial)"
wait "$rec"; code=$?
check "individual Stop disconnects the recorder with an error" "$(refused "$code")" error
wait_for recording_gone "$(field "$req" serial)"
check "Stop removes its active-recording entry" "$?" 0
check "stopping one stream leaves the other connected" \
    "$(recording_present "$other_serial" && kill -0 "$other" 2>/dev/null && echo active)" active
wait "$other"
check "the unrelated recording continues normally" "$?" 124
check "the unrelated recording still receives audio" "$(sound_of /tmp/unrelated.wav)" sound

echo "app sinks"
start_app
pw-metadata -n default 0 default.audio.sink '{"name":"evil"}' Spa:String:JSON >/dev/null
timeout -k 1 3 pw-cat --playback "$tone" >/dev/null 2>&1 & rec=$!
wait_request
check "playing into an app's sink asks first" "$(field "$req" kind)" system
answer "$req" deny
sleep 0.2
check "deny removes the app sink" "$(pw-link -i | grep -q '^evil:' && echo there || echo gone)" gone
wait "$rec"
check "playback waits after its receiving sink was denied" "$?" 124
stop_app
pw-metadata -n default 0 default.audio.sink '{"name":"fake-mic.feed"}' Spa:String:JSON >/dev/null

echo "kill switch"
timeout -k 1 8 pw-record --target fake-mic /tmp/cut.wav >/dev/null 2>&1 & rec=$!
wait_request
answer "$req" allow
wait_for recording_present "$(field "$req" serial)"
say 0 micsnitch.block 1
wait "$rec"
check "the global switch cuts a running recording" "$(refused "$?")" error
timeout -k 1 4 pw-record --target fake-mic /tmp/blocked.wav >/dev/null 2>&1
check "the global switch refuses new recordings" "$(refused "$?")" error
say 0 micsnitch.block 0

echo "direct links"
check "apps cannot wire the mic themselves" "$(self_wire)" refused
start_app
read -r on op _ < <(port_of fake-mic output)
read -r inn ip _ < <(port_of evil input)
# MicSnitch can cut the link before a slow observer sees it, so give it a few tries
inject_link() {
    pw-metadata -n default -d 0 micsnitch.test.link >/dev/null
    stdbuf -oL pw-dump -m >/tmp/injected-link.json &
    observer=$!
    wait_for client_connected "$observer"
    pw-metadata -n default 0 micsnitch.test.link "$on $op $inn $ip" >/dev/null
    sleep 0.5
    kill "$observer"
    wait "$observer" 2>/dev/null
    python3 - "$on" "$inn" <<'JSON'
import json,sys
text = open("/tmp/injected-link.json").read()
decoder, created = json.JSONDecoder(), False
while text.strip():
    batch, end = decoder.raw_decode(text.lstrip())
    text = text.lstrip()[end:]
    for o in batch:
        p = o.get("info", {}).get("props", {}) if o.get("info") else {}
        if str(p.get("link.output.node")) == sys.argv[1] and str(p.get("link.input.node")) == sys.argv[2]:
            created = True
print("created" if created else "missing")
JSON
}
for _ in 1 2 3; do
    injected=$(inject_link)
    [ "$injected" = created ] && break
done
check "the fixture really created an unapproved link" "$injected" created
cut() { ! linked fake-mic:capture_FL evil:playback_FL; }
wait_for cut || true
check "the policy removes that unapproved link" "$(cut && echo cut || echo linked)" cut
wait_request
check "the injected receiver needs consent" "$(field "$req" kind)" mic
stop_app
out=$(pactl load-module module-null-sink 2>&1)
code=$?
check "PulseAudio module loading returns an error" "$(refused "$code")" error
check "the module error explains permission denial" "$(grep -qi 'denied' <<<"$out" && echo denied || echo "$out")" denied

echo "WirePlumber restart"
stop_wireplumber
check "the protection marker disappears when its owner exits" \
    "$(active && echo stale || echo gone)" gone
check "apps connected during the restart lose direct-link permission" "$(self_wire start_wireplumber)" refused
feed_fake_mic
record /tmp/restart.wav fake-mic 3 & rec=$!
wait_request
answer "$req" allow
finish_recorder "a recorder stays alive after policy restart"
check "the existing popup connection hears new requests" \
    "$(grep -q "\"serial\":\"$(field "$req" serial)\"" /tmp/watch.txt && echo heard || echo deaf)" heard
check "popup answers still work after restart" "$(sound_of /tmp/restart.wav)" sound

echo "activity privacy"
check "nothing is left behind for other apps to read" "$(entries micsnitch.history)" '[]'

echo "popup liveness"
# On lock the popup goes away, but requests wait for it
say 0 micsnitch.ui locked
kill "$watch"
wait "$watch" 2>/dev/null
timeout -k 1 25 pw-record --target fake-mic /tmp/locked.wav >/dev/null 2>&1 & rec=$!
wait_request
sleep 16
check "a deliberate lock keeps consent pending without a monitor" \
    "$(kill -0 "$rec" 2>/dev/null && echo waiting || echo stopped)" waiting
start_popup
answer "$req" deny
wait "$rec"
check "unlock can still answer the waiting request" "$(refused "$?")" error

# A popup that crashes never says goodbye, so its "ready" stays behind.
# The timeout has to work anyway.
timeout -k 1 25 pw-record --target fake-mic /tmp/dead-popup.wav >/dev/null 2>&1 & rec=$!
wait_request
kill "$watch"
wait "$watch" 2>/dev/null
# And a new connection can't bring that dead "ready" back
pw-dump >/dev/null
check "a dead monitor clears the ready claim" "$(entries micsnitch.ui | python3 -c 'import json,sys; e=json.load(sys.stdin); print(e[0]["value"] if e else "missing")')" off
start=$SECONDS
wait "$rec"; code=$?
took=$((SECONDS - start))
check "a dead ready monitor cannot keep recordings hanging" "$(refused "$code")" error
check "a crashed popup is refused after about 15 seconds" \
    "$([ "$took" -ge 13 ] && [ "$took" -le 20 ] && echo ok || echo "${took}s")" ok

say 0 micsnitch.ui 'ready 999999'
start=$SECONDS
timeout -k 1 25 pw-record --target fake-mic /tmp/wrong-popup.wav >/dev/null 2>&1
code=$?; took=$((SECONDS - start))
check "faking the popup's pid doesn't stop the timeout" "$(refused "$code")" error
check "an invented popup PID uses the normal timeout" \
    "$([ "$took" -ge 13 ] && [ "$took" -le 20 ] && echo ok || echo "${took}s")" ok
say 0 micsnitch.ui off

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

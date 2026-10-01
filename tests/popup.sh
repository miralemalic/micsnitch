#!/bin/bash
# Exercise the actual GNOME popup in a hidden Shell and a private audio stack.
# Screenshots and assertions go to OUTDIR. Your running desktop is untouched.
#   tests/popup.sh [OUTDIR]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "${1:-.}"
out=$(realpath "${1:-.}")
tmp=$(mktemp -d)
data=$tmp/data
mkdir -p "$data/gnome-shell/extensions" "$tmp/bin" "$tmp/runtime"
chmod 700 "$tmp/runtime"
podman_cmd=(env "XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}" \
    "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}" \
    "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$UID}" podman)
cleanup() {
    "${podman_cmd[@]}" stop -t 1 micsnitch-popup >/dev/null 2>&1 || true
    rm -rf "${tmp:?}"
}
trap cleanup EXIT

XDG_RUNTIME_DIR=$tmp/runtime gjs -m tests/extension.mjs

tests/container.sh fedora44 true >/dev/null
"${podman_cmd[@]}" run -d --rm --replace --name micsnitch-popup --timeout 300 \
    -v "$PWD:/src:ro,z" -w /src localhost/micsnitch-test:fedora44 \
    dbus-run-session -- /src/tests/stack.sh bash -c \
    '. tests/lib.sh; feed_fake_mic; sleep 280' >/dev/null
inside() { "${podman_cmd[@]}" exec -i -e XDG_RUNTIME_DIR=/tmp/run micsnitch-popup "$@"; }
ready=0
for _ in $(seq 100); do
    if inside pw-metadata -n micsnitch 2>/dev/null | grep -q micsnitch.active; then ready=1; break; fi
    sleep 0.1
 done
[ "$ready" = 1 ] || { echo 'private audio stack did not start' >&2; exit 1; }

# Keep Podman's original directories even after the hidden Shell gets its own.
{
    echo '#!/bin/bash'
    printf 'exec '
    printf '%q ' "${podman_cmd[@]}"
    echo '"$@"'
} >"$tmp/bin/podman-test"
chmod +x "$tmp/bin/podman-test"

# The host Shell and container have different PIDs. Translate only readiness;
# the real project runs its monitor and WirePlumber in the same PID namespace.
cat >"$tmp/bin/pw-metadata" <<'WRAPPER'
#!/bin/bash
bridge=$(dirname "$0")/podman-test
if [ "${1:-}" = -m ]; then
    exec "$bridge" exec -i -e XDG_RUNTIME_DIR=/tmp/run micsnitch-popup \
        sh -c 'echo $$ >/tmp/ui-monitor.pid; exec stdbuf -oL pw-metadata "$@"' sh "$@"
fi
if [ "${4:-}" = micsnitch.ui ] && [[ ${5:-} =~ ^(ready|locked)\  ]]; then
    pid=$("$bridge" exec micsnitch-popup cat /tmp/ui-monitor.pid)
    set -- "${@:1:4}" "${5%% *} $pid"
fi
exec "$bridge" exec -i -e XDG_RUNTIME_DIR=/tmp/run micsnitch-popup pw-metadata "$@"
WRAPPER
chmod +x "$tmp/bin/pw-metadata"

(cd extension && gnome-extensions pack -q --force --out-dir="$tmp" \
    --extra-source=core --extra-source=dialog.js .)
(cd tests/shell-helper && gnome-extensions pack -q --force --out-dir="$tmp" .)
for zip in "$tmp"/*.zip; do
    dir=$data/gnome-shell/extensions/$(basename "$zip" .shell-extension.zip)
    mkdir -p "$dir"
    python3 -m zipfile -e "$zip" "$dir"
    if [ -d "$dir/schemas" ]; then glib-compile-schemas "$dir/schemas"; fi
done

export XDG_DATA_HOME=$data XDG_CONFIG_HOME=$tmp/config XDG_RUNTIME_DIR=$tmp/runtime
export PATH=$tmp/bin:$PATH OUT=$out
# Also exercise session detection without a logind ID in the environment.
unset XDG_SESSION_ID
# A script file keeps the nested session readable and makes failures visible.
cat >"$tmp/session.sh" <<'SESSION'
#!/bin/bash
set -euo pipefail
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.shell enabled-extensions \
    '["micsnitch-test-helper@miralemalic", "micsnitch@miralemalic"]'
gnome-shell --headless --virtual-monitor 1280x800 >"$OUT/shell.log" 2>&1 &
shell_pid=$!
trap 'kill "$shell_pid" 2>/dev/null || true' EXIT
shell() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" | python3 -c '
import ast,json,sys
text=sys.stdin.read().replace("(true,", "(True,", 1).replace("(false,", "(False,", 1)
ok,result=ast.literal_eval(text)
if not ok:
    print(result,file=sys.stderr); sys.exit(1)
try: value=json.loads(result)
except ValueError: value=result
if isinstance(value,bool): print("true" if value else "false")
elif isinstance(value,(dict,list)): print(json.dumps(value))
else: print(value)'
}
wait_shell() {
    for _ in $(seq 75); do
        [ "$(shell "$1" 2>/dev/null || true)" = "$2" ] && return 0
        sleep 0.1
    done
    echo "timed out waiting for Shell: $1 = $2" >&2
    tail -40 "$OUT/shell.log" >&2
    return 1
}
check() {
    if [ "$2" = "$3" ]; then echo "  ok    $1"
    else echo "  FAIL  $1 (expected $3, got $2)" >&2; exit 1; fi
}
shot() {
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" >/dev/null
}
inside() { podman-test exec -i -e XDG_RUNTIME_DIR=/tmp/run micsnitch-popup "$@"; }
recorder() {
    inside timeout -k 1 45 parecord --client-name="$1" \
        --property=application.process.binary=electron --device=fake-mic --file-format=wav "$2"
}
expect_denied() {
    local code
    if wait "$2"; then code=0; else code=$?; fi
    case $code in 0|124|137) check "$1" "exit $code" error ;; *) check "$1" error error ;; esac
}

wait_shell '1' 1
ext='Main.extensionManager.lookup("micsnitch@miralemalic")'
obj="$ext.stateObj"
wait_shell "$ext.state" 1
wait_shell "$obj._channel.active" true
check 'the extension starts without an error' "$(shell "$ext.error ?? ''")" ''
shell 'Main.panel.statusArea.quickSettings.menu.open()' >/dev/null
sleep 0.5
shot quick-settings
shell 'Main.panel.statusArea.quickSettings.menu.close()' >/dev/null

recorder ChatGPT /tmp/chatgpt.wav >"$OUT/chatgpt.log" 2>&1 & first=$!
wait_shell "$obj._dialog != null" true
recorder Slack /tmp/slack.wav >"$OUT/slack.log" 2>&1 & second=$!
wait_shell "$obj._queue.size" 2
check 'both requests claim the same binary' \
    "$(shell "[...$obj._queue.values()].every(e => e.request.binary === [...$obj._queue.values()][0].request.binary)")" true
check 'the first popup identifies ChatGPT' \
    "$(shell "$obj._queue.get($obj._dialog.requestId).app.name")" ChatGPT
sleep 1
shot popup
shell "$obj._dialog._remember.checked = true; $obj._dialog._respond(true)" >/dev/null
wait_shell "$obj._queue.get($obj._dialog?.requestId)?.app.name" Slack
check 'remembering ChatGPT does not answer another app sharing its binary' \
    "$(shell "$obj._settings.get_value('rules').deepUnpack()['mic:app:Slack'] ?? ''")" ''
sleep 1
shell "$obj._dialog._respond(false)" >/dev/null
expect_denied 'Deny stops Slack with an error' "$second"
wait_shell "$obj._channel.recordings.size" 1
check 'the active recording is ChatGPT' \
    "$(shell "[...$obj._channel.recordings.values()][0].app")" ChatGPT
wait_shell "$obj._activity.events.length >= 2" true
check 'recent activity includes allow and deny' \
    "$(shell "['allow','deny'].every(a => $obj._activity.events.some(e => e.action === a))")" true

toggle="$obj._indicator.quickSettingsItems[0]"
shell "Main.panel.statusArea.quickSettings.menu.open(); $toggle.menu.open()" >/dev/null
sleep 0.5
shot recording-and-activity
shell "$toggle._recordings._getMenuItems()[0].get_children().find(c => c.get_label?.() === 'Stop').emit('clicked', 1)" >/dev/null
expect_denied 'the menu Stop button disconnects ChatGPT' "$first"
wait_shell "$obj._channel.recordings.size" 0
check 'the allowed recording received real audio' \
    "$(inside bash -c '. tests/lib.sh; sound_of /tmp/chatgpt.wav')" sound
wait_shell "$obj._activity.events.some(e => e.action === 'stop')" true
shell 'Main.panel.statusArea.quickSettings.menu.close()' >/dev/null

recorder ChatGPT /tmp/remembered.wav >"$OUT/remembered.log" 2>&1 & remembered=$!
wait_shell "$obj._channel.recordings.size" 1
check 'a remembered app does not open another popup' "$(shell "$obj._dialog == null")" true
wait_shell "$obj._activity.events.some(e => e.reason === 'remembered')" true
shell "$toggle._recordings._getMenuItems()[0].get_children().find(c => c.get_label?.() === 'Stop').emit('clicked', 1)" >/dev/null
expect_denied 'a remembered recording can still be stopped individually' "$remembered"

# Enter the real unlock-dialog mode: GNOME must disable this user-only extension.
shell "global._micsnitchTestIndicator = $obj._indicator; Main.sessionMode.pushMode('unlock-dialog')" >/dev/null
wait_shell "$ext.state" 2
check 'the extension is disabled in unlock-dialog mode' "$(shell "$ext.state")" 2
check 'locking removes its indicator and recording controls' \
    "$(shell "!Main.panel.statusArea.quickSettings._indicators.get_children().includes(global._micsnitchTestIndicator) && $obj._indicator === null && $obj._channel === null")" true
check 'locking leaves only a deliberate hold claim' \
    "$(inside bash -c '. tests/lib.sh; entries micsnitch.ui' | python3 -c 'import json,sys; e=json.load(sys.stdin); print(e[0]["value"] if e else "missing")')" locked
recorder ChatGPT /tmp/locked-rule.wav >"$OUT/locked-rule.log" 2>&1 & locked_rule=$!
for _ in $(seq 50); do
    if [ "$(inside bash -c '. tests/lib.sh; entries micsnitch.request' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = 1 ]; then break; fi
    sleep 0.1
done
sleep 16
check 'a remembered request stays held for unlock without a monitor' \
    "$(inside bash -c '. tests/lib.sh; entries micsnitch.recording')" '[]'
check 'locking holds the recorder instead of timing it out' \
    "$(kill -0 "$locked_rule" 2>/dev/null && echo waiting || echo stopped)" waiting
shell "Main.sessionMode.popMode('unlock-dialog')" >/dev/null
wait_shell "$ext.state" 1
wait_shell "$obj._channel.recordings.size" 1
check 'unlock restores the extension and applies the remembered rule' \
    "$(shell "$obj._dialog == null && $obj._queue.size === 0")" true
shell "$toggle._recordings._getMenuItems()[0].get_children().find(c => c.get_label?.() === 'Stop').emit('clicked', 1)" >/dev/null
expect_denied 'the recording allowed on unlock can be stopped' "$locked_rule"

recorder Unremembered /tmp/disable.wav >"$OUT/disable.log" 2>&1 & disabled=$!
wait_shell "$obj._dialog != null" true
before=$(shell 'Main.modalCount')
history_count=$(shell "$obj._activity.events.length")
shell 'Main.extensionManager.disableExtension("micsnitch@miralemalic")' >/dev/null
wait_shell 'Main.modalCount' "$((before - 1))"
check 'disabling a popup releases its modal grab' "$(shell 'Main.modalCount')" "$((before - 1))"
shell 'Main.extensionManager.enableExtension("micsnitch@miralemalic")' >/dev/null
wait_shell "$obj._dialog != null" true
check 'recent decisions survive extension disable and re-enable' \
    "$(shell "$obj._activity.events.length >= $history_count")" true
sleep 1
shell "$obj._dialog._respond(false)" >/dev/null
expect_denied 'the restored popup can deny its pending recorder' "$disabled"
check 'the extension remains protected' "$(shell "$obj._channel.active")" true
echo 'popup checks passed'
SESSION
chmod +x "$tmp/session.sh"
if ! dbus-run-session -- "$tmp/session.sh" 2>"$out/session.log" | tee "$out/results.txt"; then
    tail -40 "$out/session.log" >&2
    exit 1
fi
echo "screenshots in $out"

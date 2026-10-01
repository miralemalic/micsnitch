#!/bin/bash
# The extension in a hidden GNOME Shell, next to a private audio stack.
# Runs inside a test container; use tests/popup.sh to start it.
set -euo pipefail
# shellcheck source=tests/lib.sh
. tests/lib.sh
out=${OUT:-/out}

gjs -m tests/extension.mjs

# Services started on demand, like the settings store, must share our runtime
# folder, or the Shell never hears about saved settings.
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.UpdateActivationEnvironment \
    "{'XDG_RUNTIME_DIR': '$XDG_RUNTIME_DIR'}" >/dev/null
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'

# Install the popup the way people do, while no Shell knows about it yet.
tools/install.sh --no-restart >/dev/null
installed=$(gsettings get org.gnome.shell enabled-extensions)
pack=$(mktemp -d)
(cd tests/shell-helper && gnome-extensions pack -q --force --out-dir="$pack" .)
gnome-extensions install --force "$pack"/*.zip
gsettings set org.gnome.shell enabled-extensions \
    "${installed%]}, 'micsnitch-test-helper@miralemalic']"

feed_fake_mic
# GNOME Shell won't start without a system bus, even an empty one, and it
# looks for logind when this folder exists. Containers don't run logind.
mkdir -p /run/dbus
dbus-daemon --system --fork
rm -rf /run/systemd/seats
# GNOME 48 also wants somewhere to put its X11 socket.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
gnome-shell --headless --virtual-monitor 1280x800 >"$out/shell.log" 2>&1 &
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
    for _ in $(seq 150); do
        [ "$(shell "$1" 2>/dev/null || true)" = "$2" ] && return 0
        sleep 0.1
    done
    echo "timed out waiting for Shell: $1 = $2" >&2
    tail -40 "$out/shell.log" >&2
    return 1
}
# Each step builds on the one before, so stop at the first failure.
check() {
    if [ "$2" = "$3" ]; then echo "  ok    $1"
    else echo "  FAIL  $1 (expected $3, got $2)"; exit 1; fi
}
recorder() {
    timeout -k 1 45 parecord --client-name="$1" \
        --property=application.process.binary=electron --device=fake-mic --file-format=wav "$2"
}
expect_denied() {
    local code
    if wait "$2"; then code=0; else code=$?; fi
    case $code in 0|124|137) check "$1" "exit $code" error ;; *) check "$1" error error ;; esac
}
stop_first_recording() {
    shell "$toggle._recordings._getMenuItems()[0].get_children().find(c => c.get_label?.() === 'Stop').emit('clicked', 1)" >/dev/null
}

wait_shell '1' 1
echo "$(gnome-shell --version)"
ext='Main.extensionManager.lookup("micsnitch@miralemalic")'
obj="$ext.stateObj"
toggle="$obj._indicator.quickSettingsItems[0]"
wait_shell "$ext.state" 1
wait_shell "$obj._channel.active" true
check 'the extension starts without an error' "$(shell "$ext.error ?? ''")" ''
check 'the installer switched the popup on for the next login' \
    "$(grep -c "'micsnitch@miralemalic'" <<<"$installed")" 1
recorder ChatGPT /tmp/chatgpt.wav >"$out/chatgpt.log" 2>&1 & first=$!
wait_shell "$obj._dialog != null" true
recorder Slack /tmp/slack.wav >"$out/slack.log" 2>&1 & second=$!
wait_shell "$obj._queue.size" 2
check 'both requests claim the same binary' \
    "$(shell "[...$obj._queue.values()].every(e => e.request.binary === [...$obj._queue.values()][0].request.binary)")" true
check 'the first popup identifies ChatGPT' \
    "$(shell "$obj._queue.get($obj._dialog.requestId).app.name")" ChatGPT
sleep 1
shell "$obj._dialog._remember.checked = true; $obj._dialog._respond(true)" >/dev/null
wait_shell "$obj._queue.get($obj._dialog?.requestId)?.app.name" Slack
check 'remembering ChatGPT does not answer another app sharing its binary' \
    "$(shell "Object.keys($obj._settings.get_value('rules').deepUnpack())")" '["mic:app:electron / ChatGPT"]'
sleep 1
shell "$obj._dialog._respond(false)" >/dev/null
expect_denied 'Deny stops Slack with an error' "$second"
wait_shell "$obj._channel.recordings.size" 1
check 'the active recording is ChatGPT' \
    "$(shell "[...$obj._channel.recordings.values()][0].app")" ChatGPT
wait_shell "$obj._activity.events.length >= 2" true
check 'recent activity includes allow and deny' \
    "$(shell "['allow','deny'].every(a => $obj._activity.events.some(e => e.action === a))")" true

shell "Main.panel.statusArea.quickSettings.menu.open(); $toggle.menu.open()" >/dev/null
# Let some real sound reach the recorder before stopping it
sleep 2
stop_first_recording
expect_denied 'the menu Stop button disconnects ChatGPT' "$first"
wait_shell "$obj._channel.recordings.size" 0
check 'the allowed recording received real audio' "$(sound_of /tmp/chatgpt.wav)" sound
wait_shell "$obj._activity.events.some(e => e.action === 'stop')" true
shell 'Main.panel.statusArea.quickSettings.menu.close()' >/dev/null

recorder ChatGPT /tmp/remembered.wav >"$out/remembered.log" 2>&1 & remembered=$!
wait_shell "$obj._channel.recordings.size" 1
check 'a remembered app does not open another popup' "$(shell "$obj._dialog == null")" true
wait_shell "$obj._activity.events.some(e => e.reason === 'remembered')" true
stop_first_recording
expect_denied 'a remembered recording can still be stopped individually' "$remembered"

# Enter the real unlock-dialog mode: GNOME must disable this user-only extension.
shell "global._micsnitchTestIndicator = $obj._indicator; Main.sessionMode.pushMode('unlock-dialog')" >/dev/null
wait_shell "$ext.state" 2
check 'the extension is disabled in unlock-dialog mode' "$(shell "$ext.state")" 2
check 'locking removes its indicator and recording controls' \
    "$(shell "!Main.panel.statusArea.quickSettings._indicators.get_children().includes(global._micsnitchTestIndicator) && $obj._indicator === null && $obj._channel === null")" true
check 'locking leaves only a deliberate hold claim' \
    "$(entries micsnitch.ui | python3 -c 'import json,sys; e=json.load(sys.stdin); print(e[0]["value"] if e else "missing")')" locked
recorder ChatGPT /tmp/locked-rule.wav >"$out/locked-rule.log" 2>&1 & locked_rule=$!
for _ in $(seq 50); do
    [ "$(entries micsnitch.request | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = 1 ] && break
    sleep 0.1
done
sleep 16
check 'a remembered request stays held for unlock without a monitor' "$(entries micsnitch.recording)" '[]'
check 'locking holds the recorder instead of timing it out' \
    "$(kill -0 "$locked_rule" 2>/dev/null && echo waiting || echo stopped)" waiting
shell "Main.sessionMode.popMode('unlock-dialog')" >/dev/null
wait_shell "$ext.state" 1
wait_shell "$obj._channel.recordings.size" 1
check 'unlock restores the extension and applies the remembered rule' \
    "$(shell "$obj._dialog == null && $obj._queue.size === 0")" true
stop_first_recording
expect_denied 'the recording allowed on unlock can be stopped' "$locked_rule"

recorder Unremembered /tmp/disable.wav >"$out/disable.log" 2>&1 & disabled=$!
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
check 'GNOME Shell logged no errors from MicSnitch' \
    "$(grep -A25 -E 'JS ERROR|JS WARNING|Gjs-CRITICAL' "$out/shell.log" | grep -ci micsnitch)" 0
echo 'popup checks passed'

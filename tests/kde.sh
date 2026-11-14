#!/bin/bash
# The tray app on a hidden KWin, next to a private audio stack. Or on Sway,
# niri or COSMIC: tests/kde.sh sway.
# Runs inside a test container; use tests/popup.sh DISTRO-kde to start it.
set -euo pipefail
# shellcheck source=tests/lib.sh
. tests/lib.sh
out=${OUT:-/out}
desktop=${1:-kde}
# The logs are read for errors at the end, so start them fresh
rm -f "$out/app.log" "$out/compositor.log"

gjs -m tests/core.mjs

export XDG_CURRENT_DESKTOP=$desktop
tools/install.sh --no-restart >/dev/null
home=$HOME/.local/share/micsnitch
settings=$HOME/.config/micsnitch/settings.ini

feed_fake_mic
# KWin wants a system bus, even an empty one
mkdir -p /run/dbus
dbus-daemon --system --fork
start_compositor() {
    if [ "$desktop" = kde ]; then
        kwin_wayland --virtual "$@" --width 1280 --height 800 --socket wayland-0 \
            >>"$out/compositor.log" 2>&1 &
        compositor=$!
        export WAYLAND_DISPLAY=wayland-0
    else
        # Sway leaves wayland-0 alone and takes the next one
        WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway -c /dev/null \
            >>"$out/compositor.log" 2>&1 &
        compositor=$!
        export WAYLAND_DISPLAY=wayland-1
    fi
    wait_for test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
    # niri and COSMIC open a window on that Sway and run inside it
    case $desktop in
        niri) niri -c /dev/null >>"$out/compositor.log" 2>&1 & ;;
        cosmic) cosmic-comp >>"$out/compositor.log" 2>&1 & ;;
        *) return ;;
    esac
    export WAYLAND_DISPLAY=wayland-2
    wait_for test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
}
# Like the systemd service: in the background, no window
start_app() {
    "$home/micsnitch" --gapplication-service >>"$out/app.log" 2>&1 &
    app=$!
}
gjs -m tests/kde-session.mjs >"$out/session.log" 2>&1 &
session=$!
start_compositor --no-lockscreen
start_app
trap 'kill "$app" "$compositor" "$session" 2>/dev/null || true' EXIT

# Each step builds on the one before, so stop at the first failure
check() {
    if [ "$2" = "$3" ]; then echo "  ok    $1"
    else echo "  FAIL  $1 (expected $3, got $2)"; exit 1; fi
}
soon() {
    for _ in $(seq 100); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
    echo "timed out waiting for: $*" >&2
    tail -20 "$out/app.log" >&2
    return 1
}
# The first word of a global key, like "ready" out of "ready 42"
value() {
    entries "$1" | python3 -c '
import json, sys
e = json.load(sys.stdin)
print(str(e[0]["value"]).split()[0] if e else "missing")'
}
ui() { value micsnitch.ui; }
ui_is() { [ "$(ui)" = "$1" ]; }
block_is() { [ "$(value micsnitch.block)" = "$1" ]; }
count() { entries "$1" | python3 -c 'import json, sys; print(len(json.load(sys.stdin)))'; }
requests_are() { [ "$(count micsnitch.request)" = "$1" ]; }
recordings_are() { [ "$(count micsnitch.recording)" = "$1" ]; }
shows() { gjs -m tests/atspi.mjs text | grep -qF -- "$1"; }
press() {
    gjs -m tests/atspi.mjs press "$@" || { echo "  FAIL  nothing to press: $*"; exit 1; }
}
asks() { shows "Allow $1 to use the microphone?"; }
forgotten() { ! grep -q "$1" "$settings"; }
events() {
    python3 -c '
import json, sys
print(json.dumps([[e["app"], e["action"], bool(e.get("undone"))]
    for e in json.load(open(sys.argv[1]))["events"]]))' "$XDG_RUNTIME_DIR/micsnitch-activity.json"
}
undone() { events | grep -qF "[\"$1\", \"deny\", true]"; }
lock() {
    gdbus call --session --dest org.freedesktop.ScreenSaver --object-path /org/freedesktop/ScreenSaver \
        --method org.freedesktop.ScreenSaver."$1" "${@:2}" >/dev/null
}
tray() {
    gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher \
        --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher \
        RegisteredStatusNotifierItems | grep -o ':[0-9.]*' | tail -1
}
tray_says() {
    gdbus call --session --dest "$(tray)" --object-path /StatusNotifierItem \
        --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem "${1:-ToolTip}"
}
notifications() {
    gdbus call --session --dest org.freedesktop.Notifications \
        --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications."$1" "${@:2}"
}
notified() { notifications Shown | grep -qF "$1"; }
remember() { printf "[micsnitch]\nrules={'mic:app:electron / %s': '%s'}\n" "$1" "$2" >"$settings"; }
reasons() {
    python3 -c '
import json, sys
print(" ".join(e.get("reason", "") for e in json.load(open(sys.argv[1]))["events"] if e["app"] == sys.argv[2]))' \
        "$XDG_RUNTIME_DIR/micsnitch-activity.json" "$1"
}

case $desktop in
    kde) kwin_wayland --version 2>/dev/null ;;
    cosmic) echo "cosmic-comp, in $(sway --version)" ;;
    *) "$desktop" --version ;;
esac
check 'the installer sets the app to start with the session' \
    "$(readlink "$HOME/.config/systemd/user/graphical-session.target.wants/micsnitch.service")" \
    ../micsnitch.service
soon ui_is ready
check 'the app tells the gate it is ready' "$(ui)" ready
soon tray
check 'its icon joins the system tray' "$(tray_says | grep -c 'No apps recording')" 1
check 'starting in the background opens no window' "$(shows 'Recording Now' && echo open || echo none)" none

LD_PRELOAD=libgtk4-layer-shell.so.0 gjs -m tests/kde-dialog.mjs "$home"

recorder Discord /tmp/discord.wav >"$out/discord.log" 2>&1 & first=$!
soon asks Discord
check 'the popup names Discord' "$(asks Discord && echo yes)" yes
recorder Slack /tmp/slack.wav >"$out/slack.log" 2>&1 & second=$!
soon requests_are 2
sleep 1
press Allow
soon asks Slack
check 'Slack waits its turn, then gets its own popup' "$(asks Slack && echo yes)" yes
sleep 1
press Deny
expect_denied 'Deny stops Slack with an error' "$second"
soon recordings_are 1
check 'Discord is recording' "$(entries micsnitch.recording | grep -c '"Discord"')" 1
check 'the tray says who is recording' "$(tray_says | grep -c 'Recording: Discord')" 1
check 'and its icon shows a recording is on' "$(tray_says IconName | grep -c media-record)" 1
check 'recent activity has the allow and the deny' "$(events)" \
    '[["Discord", "allow", false], ["Slack", "deny", false]]'

# The tray icon opens the window
gdbus call --session --dest "$(tray)" --object-path /StatusNotifierItem \
    --method org.kde.StatusNotifierItem.Activate 0 0 >/dev/null
soon shows 'Recording Now'
check 'the tray icon opens the window' "$(shows 'Recording Now' && echo open)" open

# Without the undo, Slack would be refused again for 30 seconds
press Undo Slack
soon undone Slack
recorder Slack /tmp/slack2.wav >>"$out/slack.log" 2>&1 & slack2=$!
soon asks Slack
check 'after Undo a denied app is asked again' "$(asks Slack && echo yes)" yes
sleep 1
press Deny
expect_denied 'and can be refused again' "$slack2"

# Let some real sound reach the recorder before stopping it
sleep 2
press Stop Discord
expect_denied 'Stop in the window disconnects Discord' "$first"
soon recordings_are 0
check 'the allowed recording received real audio' "$(sound_of /tmp/discord.wav)" sound

recorder Repeat /tmp/repeat1.wav >"$out/repeat.log" 2>&1 & repeat1=$!
soon asks Repeat
sleep 1
press Allow
soon recordings_are 1
recorder Repeat /tmp/repeat2.wav >>"$out/repeat.log" 2>&1 & repeat2=$!
soon recordings_are 2
check 'the same app asking again right away gets no second popup' \
    "$(asks Repeat && echo popup || echo none)" none
press Stop Repeat
soon recordings_are 1
press Stop Repeat
expect_denied 'both of its recordings can be stopped' "$repeat1"
expect_denied 'and both end' "$repeat2"

check 'with nobody recording the tray icon is the plain one again' \
    "$(tray_says IconName | grep -c audio-input-microphone)" 1

# A Remember tick, the way the popup saves it
remember Remembered allow
soon shows 'electron / Remembered'
check 'the window lists remembered apps' "$(shows 'electron / Remembered' && echo listed)" listed
recorder Remembered /tmp/remembered.wav >"$out/remembered.log" 2>&1 & remembered=$!
soon recordings_are 1
check 'a remembered app does not open a popup' "$(asks Remembered && echo popup || echo none)" none
press Stop Remembered
expect_denied 'a remembered recording can still be stopped' "$remembered"

lock SetActive true
soon ui_is locked
check 'locking tells the gate to hold requests' "$(ui)" locked
recorder Remembered /tmp/locked.wav >"$out/locked.log" 2>&1 & locked=$!
soon requests_are 1
sleep 16
check 'a remembered request stays held while locked' "$(count micsnitch.recording)" 0
check 'the recorder waits instead of timing out' \
    "$(kill -0 "$locked" 2>/dev/null && echo waiting || echo stopped)" waiting
lock SetActive false
soon ui_is ready
soon recordings_are 1
check 'unlocking applies the remembered answer' "$(ui)" ready
press Stop Remembered
expect_denied 'the recording allowed on unlock can be stopped' "$locked"

recorder Stray /tmp/stray.wav >"$out/stray.log" 2>&1 & stray=$!
soon asks Stray
press Microphone
soon block_is 1
expect_denied 'switching the microphone off refuses what is waiting' "$stray"
check 'and the tray says so' "$(tray_says | grep -c 'Microphone off')" 1
recorder Blocked /tmp/blocked.wav >"$out/blocked.log" 2>&1 & blocked=$!
expect_denied 'new recordings are refused while it is off' "$blocked"
turned_away() { [ "$(reasons Blocked)" = off ]; }
soon turned_away
check 'and who tried is listed, once' "$(reasons Blocked)" off
press Microphone
soon block_is 0

# Sway, Hyprland and niri lock with a program like swaylock, which tells nobody
printf '#!/bin/sh\nwhile :; do sleep 1; done\n' >/tmp/swaylock
chmod +x /tmp/swaylock
/tmp/swaylock & locker=$!
recorder Remembered /tmp/quiet.wav >"$out/quiet.log" 2>&1 & quiet=$!
soon requests_are 1
sleep 3
check 'a lock screen that tells nobody still holds requests' "$(count micsnitch.recording)" 0
kill "$locker"
soon recordings_are 1
check 'and they go on once it is gone' "$(count micsnitch.recording)" 1
press Stop Remembered
expect_denied 'the recording allowed after it can be stopped' "$quiet"

press Forget Remembered
soon forgotten Remembered
check 'Forget drops a remembered app' "$(forgotten Remembered && echo gone)" gone

# A remembered no gets no popup, so a notification has to say why the app is stuck
remember Banned deny
soon shows 'electron / Banned'
recorder Banned /tmp/banned.wav >"$out/banned.log" 2>&1 & banned=$!
expect_denied 'an app with a remembered no is refused' "$banned"
soon notified 'Banned was denied the microphone'
check 'and a notification says so' "$(notified 'Banned was denied the microphone' && echo told)" told
notifications Press 'Banned was denied the microphone' >/dev/null
soon forgotten Banned
check 'Undo on the notification forgets the answer' "$(forgotten Banned && echo gone)" gone

# An answer that was only good until an earlier logout
remember Stale 'allow another-login'
recorder Stale /tmp/stale.wav >"$out/stale.log" 2>&1 & stale=$!
soon asks Stale
check 'an answer from an earlier login asks again' "$(asks Stale && echo yes)" yes
sleep 1
press Deny
expect_denied 'and can be refused' "$stale"

# Something answers the gate while the popup is still asking
recorder Forger /tmp/forger.wav >"$out/forger.log" 2>&1 & forger=$!
soon asks Forger
read -r node serial < <(entries micsnitch.request | python3 -c '
import json, sys
e = json.load(sys.stdin)[0]
print(e["id"], e["value"]["serial"])')
pw-metadata -n micsnitch "$node" micsnitch.answer "allow $serial mic" >/dev/null
soon notified 'Forger is recording without your permission'
listed() { [ "$(reasons Forger)" = forged ]; }
soon listed
check 'a recording nobody approved raises the alarm' "$(reasons Forger)" forged
notifications Press 'Forger is recording without your permission' >/dev/null
expect_denied 'and Stop on the alarm ends it' "$forger"

kill -TERM "$app"
wait "$app" || true
check 'quitting tells the gate the popup is gone' "$(ui)" off

# Like systemd bringing it back after a crash
start_app
soon ui_is ready
"$home/micsnitch" >>"$out/app.log" 2>&1
soon shows 'Recent Activity'
check "a restarted app still lists this login's decisions" "$(shows 'Slack' && echo listed)" listed

if [ "$desktop" = kde ]; then
    # A real Plasma lock, from KWin itself. The test can't unlock it.
    kill "$app" "$session" "$compositor"
    wait "$compositor" 2>/dev/null || true
    start_compositor
    start_app
    soon ui_is ready
    gdbus call --session --dest org.freedesktop.ScreenSaver --object-path /org/freedesktop/ScreenSaver \
        --method org.freedesktop.ScreenSaver.Lock >/dev/null
    soon ui_is locked
    check "KWin's own lock screen holds requests too" "$(ui)" locked
else
    # The real swaylock this time. A signal is its way of being unlocked by a test.
    remember Remembered allow
    swaylock >>"$out/compositor.log" 2>&1 & locker=$!
    sleep 2
    recorder Remembered /tmp/swaylock.wav >"$out/swaylock.log" 2>&1 & held=$!
    soon requests_are 1
    sleep 3
    check 'the real swaylock holds a remembered request' "$(count micsnitch.recording)" 0
    kill -USR1 "$locker"
    soon recordings_are 1
    check 'and unlocking lets it through' "$(count micsnitch.recording)" 1
    kill "$held"
fi

# GTK grumbles about every layer window; that one is GTK's, not ours
check 'the app logged no errors' \
    "$(grep -E 'JS ERROR|JS WARNING|CRITICAL' "$out/app.log" | grep -vc 'set_a11y_properties')" 0
echo "$desktop checks passed"

#!/bin/bash
# Installs MicSnitch for the current user. No root needed.
#   --no-restart    leave the audio services running
#   --no-extension leave out the GNOME popup
set -euo pipefail
cd "$(dirname "$0")/.."

data=${XDG_DATA_HOME:-$HOME/.local/share}
cfg=${XDG_CONFIG_HOME:-$HOME/.config}
uuid=micsnitch@miralemalic
restart=1 extension=1
for arg; do
    case $arg in
        --no-restart) restart=0 ;;
        --no-extension) extension=0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

need() {
    command -v "$1" >/dev/null || { echo "Missing $1; install it before continuing." >&2; exit 1; }
}
check_version() {
    local output
    output=$("$1" --version)
    if [[ $output =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] &&
       (( 10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} * 1000 +
          10#${BASH_REMATCH[3]} >= $2 * 1000000 + $3 * 1000 + $4 )); then
        return
    fi
    echo "MicSnitch needs $1 $2.$3.$4 or newer." >&2
    exit 1
}
for cmd in pipewire wireplumber; do need "$cmd"; done
[ "$restart" = 0 ] || need systemctl
check_version pipewire 1 2 0
check_version wireplumber 0 5 8

# Without the popup nothing can be allowed, so every app would lose the mic.
# Only go ahead without it when asked to.
if [ "$extension" = 1 ]; then
    shell=$(gnome-shell --version 2>/dev/null || true)   # "GNOME Shell 50.5"
    shell=${shell##* }
    tested=$(sed -n '/shell-version/,/]/p' extension/metadata.json | grep -o '[0-9]\+')
    if ! command -v gnome-extensions >/dev/null || ! grep -qx "${shell%%.*}" <<<"$tested" ||
        [[ -n ${XDG_CURRENT_DESKTOP:-} && ${XDG_CURRENT_DESKTOP,,} != *gnome* ]]; then
        echo "The MicSnitch popup needs GNOME $(paste -sd/ <<<"$tested")." >&2
        echo "Without it every app would be refused the microphone. If that's what" >&2
        echo "you want, run this again with --no-extension." >&2
        exit 1
    fi
fi

if [ "$extension" = 1 ]; then
    for cmd in pw-metadata stdbuf glib-compile-schemas; do need "$cmd"; done
    out=$(mktemp -d)
    trap 'rm -rf "${out:?}"' EXIT
    # Build the popup first, so a broken one never gets near the audio setup
    glib-compile-schemas --strict --dry-run extension/schemas
    (cd extension && gnome-extensions pack -q --force --out-dir="$out" \
        --extra-source=core --extra-source=dialog.js .)
    gnome-extensions install --force "$out/$uuid.shell-extension.zip"
    glib-compile-schemas "$data/gnome-shell/extensions/$uuid/schemas"
fi

install -Dm644 wireplumber/micsnitch.lua "$data/wireplumber/scripts/micsnitch.lua"
install -Dm644 wireplumber/micsnitch.conf "$cfg/wireplumber/wireplumber.conf.d/micsnitch.conf"
for conf in pipewire.conf.d pipewire-pulse.conf.d; do
    install -Dm644 "pipewire/$conf/50-micsnitch.conf" "$cfg/pipewire/$conf/50-micsnitch.conf"
done

if [ "$extension" = 1 ]; then
    # GNOME only learns about a new extension at the next login, so until then
    # it can't enable it. Put it on the list for that login instead.
    if ! gnome-extensions enable "$uuid" 2>/dev/null; then
        enabled=$(gsettings get org.gnome.shell enabled-extensions)
        case $enabled in
            *"'$uuid'"*) ;;
            "@as []") gsettings set org.gnome.shell enabled-extensions "['$uuid']" ;;
            *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$uuid']" ;;
        esac
    fi
    if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = true ]; then
        echo "Extensions are switched off in GNOME; turn them on in the Extensions app." >&2
    fi
fi
if [ "$restart" = 1 ]; then
    systemctl --user restart pipewire pipewire-pulse wireplumber
fi

if [ "$extension" = 1 ]; then
    echo "Done. Log out and back in once to start the popup."
else
    echo "No popup installed: requests time out and are denied after 15 seconds."
fi
if [ "$restart" = 0 ]; then
    echo "Restart pipewire, pipewire-pulse and wireplumber when ready to activate the policy."
fi

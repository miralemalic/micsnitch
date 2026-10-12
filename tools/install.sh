#!/bin/bash
# Installs MicSnitch for the current user. No root needed.
#   --no-restart    leave the audio services and the KDE app running as they are
#   --no-extension  leave out the popup, on GNOME and KDE alike
set -euo pipefail
cd "$(dirname "$0")/.."

data=${XDG_DATA_HOME:-$HOME/.local/share}
cfg=${XDG_CONFIG_HOME:-$HOME/.config}
uuid=micsnitch@miralemalic
app=io.github.miralemalic.MicSnitch
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

# Without a popup nothing can be allowed, so every app would lose the mic.
# Only go ahead without one when asked to.
desktop=none
if [ "$extension" = 1 ]; then
    shell=$(gnome-shell --version 2>/dev/null || true)   # "GNOME Shell 50.5"
    shell=${shell##* }
    tested=$(sed -n '/shell-version/,/]/p' extension/metadata.json | grep -o '[0-9]\+')
    current=${XDG_CURRENT_DESKTOP:-}
    case ${current,,} in
        *kde*) desktop=kde ;;
        *gnome*|'')
            if command -v gnome-extensions >/dev/null && grep -qx "${shell%%.*}" <<<"$tested"; then
                desktop=gnome
            fi ;;
    esac
    if [ "$desktop" = none ]; then
        echo "The MicSnitch popup needs GNOME $(paste -sd/ <<<"$tested") or KDE Plasma." >&2
        echo "Without it every app would be refused the microphone. If that's what" >&2
        echo "you want, run this again with --no-extension." >&2
        exit 1
    fi
    # Calling into gtk4-layer-shell proves the library is there, not just its description
    if [ "$desktop" = kde ] && ! { command -v glib-compile-schemas && command -v gjs &&
        gjs -c "imports.gi.versions.Gtk = '4.0'; imports.gi.Adw;
                const version = imports.gi.Gtk4LayerShell.get_major_version();"; } >/dev/null 2>&1; then
        echo "MicSnitch on KDE needs GJS, libadwaita and gtk4-layer-shell:" >&2
        echo "  Fedora: sudo dnf install gjs libadwaita gtk4-layer-shell" >&2
        echo "  Debian, Ubuntu: sudo apt install gjs gir1.2-adw-1 gir1.2-gtk4layershell-1.0 \\" >&2
        echo "      libgtk4-layer-shell0 libglib2.0-bin" >&2
        echo "  Arch: sudo pacman -S gjs libadwaita gtk4-layer-shell" >&2
        exit 1
    fi
    for cmd in pw-metadata stdbuf glib-compile-schemas; do need "$cmd"; done
    glib-compile-schemas --strict --dry-run schemas
fi

# Build the popup first, so a broken one never gets near the audio setup
if [ "$desktop" = gnome ]; then
    out=$(mktemp -d)
    trap 'rm -rf "${out:?}"' EXIT
    (cd extension && gnome-extensions pack -q --force --out-dir="$out" \
        --extra-source=../core --extra-source=dialog.js \
        --schema=../schemas/org.gnome.shell.extensions.micsnitch.gschema.xml .)
    gnome-extensions install --force "$out/$uuid.shell-extension.zip"
    glib-compile-schemas "$data/gnome-shell/extensions/$uuid/schemas"
fi
if [ "$desktop" = kde ]; then
    home=$data/micsnitch
    rm -rf "${home:?}"
    install -Dm644 -t "$home" app/*.js app/style.css
    install -Dm755 app/micsnitch "$home/micsnitch"
    install -Dm644 -t "$home/core" core/*.js
    install -Dm644 -t "$home/schemas" schemas/*.xml
    glib-compile-schemas "$home/schemas"
    mkdir -p "$cfg/systemd/user/graphical-session.target.wants" "$data/applications"
    sed "s|@LAUNCHER@|$home/micsnitch|" app/micsnitch.service >"$cfg/systemd/user/micsnitch.service"
    sed "s|@LAUNCHER@|$home/micsnitch|" "app/$app.desktop" >"$data/applications/$app.desktop"
    # What systemctl enable does, without needing systemd to be running
    ln -sf ../micsnitch.service "$cfg/systemd/user/graphical-session.target.wants/micsnitch.service"
fi

install -Dm644 wireplumber/micsnitch.lua "$data/wireplumber/scripts/micsnitch.lua"
install -Dm644 wireplumber/micsnitch.conf "$cfg/wireplumber/wireplumber.conf.d/micsnitch.conf"
for conf in pipewire.conf.d pipewire-pulse.conf.d; do
    install -Dm644 "pipewire/$conf/50-micsnitch.conf" "$cfg/pipewire/$conf/50-micsnitch.conf"
done

if [ "$desktop" = gnome ]; then
    # GNOME only learns about a new extension at the next login, so until then it can't enable it.
    # Put it on the list for that login instead.
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
started=0
if [ "$restart" = 1 ]; then
    systemctl --user restart pipewire pipewire-pulse wireplumber
    # KDE gets the popup right away, no need to log out
    if [ "$desktop" = kde ] && systemctl --user -q is-active graphical-session.target; then
        systemctl --user daemon-reload
        systemctl --user restart micsnitch.service
        started=1
    fi
fi

case $desktop in
    gnome) echo "Done. Log out and back in once to start the popup." ;;
    kde)
        if [ "$started" = 1 ]; then echo "Done. MicSnitch is in the system tray."
        else echo "Done. MicSnitch starts with your next login."; fi ;;
    none) echo "No popup installed: requests time out and are denied after 15 seconds." ;;
esac
if [ "$restart" = 0 ]; then
    echo "Restart pipewire, pipewire-pulse and wireplumber when ready to activate the policy."
fi

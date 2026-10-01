#!/bin/bash
# Removes this user's MicSnitch files. --no-restart leaves the audio stack running.
set -euo pipefail
restart=1
for arg; do
    case $arg in
        --no-restart) restart=0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

data=${XDG_DATA_HOME:-$HOME/.local/share}
cfg=${XDG_CONFIG_HOME:-$HOME/.config}

gnome-extensions uninstall micsnitch@miralemalic 2>/dev/null || true
rm -f "$data/wireplumber/scripts/micsnitch.lua" \
      "$cfg/wireplumber/wireplumber.conf.d/micsnitch.conf" \
      "$cfg/pipewire/pipewire.conf.d/50-micsnitch.conf" \
      "$cfg/pipewire/pipewire-pulse.conf.d/50-micsnitch.conf"
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    rm -f "$XDG_RUNTIME_DIR/micsnitch-activity.json"
fi

if [ "$restart" = 1 ]; then
    systemctl --user restart pipewire pipewire-pulse wireplumber
fi

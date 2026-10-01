ARG IMAGE=debian:trixie
FROM docker.io/library/${IMAGE}
ARG GNOME=
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        pipewire wireplumber pipewire-pulse pipewire-bin pulseaudio-utils dbus python3 \
    && if [ -n "$GNOME" ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y \
        --no-install-recommends gnome-shell libgl1-mesa-dri dconf-service; fi \
    && rm -rf /var/lib/apt/lists/*

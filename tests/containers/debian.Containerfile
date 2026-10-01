ARG IMAGE=debian:trixie
FROM docker.io/library/${IMAGE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        pipewire wireplumber pipewire-pulse pipewire-bin pulseaudio-utils dbus python3 \
    && rm -rf /var/lib/apt/lists/*

ARG IMAGE=debian:trixie
FROM docker.io/library/${IMAGE}
ARG GNOME=
ARG KDE=
# Rootless containers can't run a program that carries file capabilities, and
# kwin_wayland has one. Rewriting the file in place drops it.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        pipewire wireplumber pipewire-pulse pipewire-bin pulseaudio-utils dbus python3 \
    && if [ -n "$GNOME" ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y \
        --no-install-recommends gnome-shell libgl1-mesa-dri dconf-service; fi \
    && if [ -n "$KDE" ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y \
        --no-install-recommends kwin-wayland gjs gir1.2-adw-1 gir1.2-gtk4layershell-1.0 \
        libgtk4-layer-shell0 libglib2.0-bin at-spi2-core gir1.2-atspi-2.0 libgl1-mesa-dri \
        && cp /usr/bin/kwin_wayland /tmp/kwin && cat /tmp/kwin >/usr/bin/kwin_wayland && rm /tmp/kwin; fi \
    && rm -rf /var/lib/apt/lists/*

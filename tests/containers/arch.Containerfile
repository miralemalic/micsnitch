FROM docker.io/library/archlinux:latest
ARG GNOME=
ARG KDE=
# Rootless containers can't run a program that carries file capabilities, and
# kwin_wayland has one. Rewriting the file in place drops it.
RUN pacman -Syu --noconfirm pipewire wireplumber pipewire-pulse libpulse dbus python \
    && if [ -n "$GNOME" ]; then pacman -S --noconfirm gnome-shell mesa; fi \
    && if [ -n "$KDE" ]; then pacman -S --noconfirm kwin gjs libadwaita gtk4-layer-shell \
        at-spi2-core mesa && cp /usr/bin/kwin_wayland /tmp/kwin && cat /tmp/kwin >/usr/bin/kwin_wayland && rm /tmp/kwin; fi \
    && pacman -Scc --noconfirm

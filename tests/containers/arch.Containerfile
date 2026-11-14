FROM docker.io/library/archlinux:latest
ARG GNOME=
ARG KDE=
ARG SWAY=
# Rootless containers can't run a program that carries file capabilities, and
# kwin_wayland and sway have one. Rewriting the file in place drops it.
RUN pacman -Syu --noconfirm pipewire wireplumber pipewire-pulse libpulse dbus python \
    && if [ -n "$GNOME" ]; then pacman -S --noconfirm gnome-shell mesa; fi \
    && if [ -n "$KDE" ]; then pacman -S --noconfirm kwin gjs libadwaita gtk4-layer-shell \
        at-spi2-core mesa && cp /usr/bin/kwin_wayland /tmp/kwin && cat /tmp/kwin >/usr/bin/kwin_wayland && rm /tmp/kwin; fi \
    && if [ -n "$SWAY" ]; then pacman -S --noconfirm $SWAY swaylock gjs libadwaita gtk4-layer-shell \
        at-spi2-core mesa \
        && for bin in $SWAY; do cp /usr/bin/$bin /tmp/bin && cat /tmp/bin >/usr/bin/$bin && rm /tmp/bin; done; fi \
    && pacman -Scc --noconfirm

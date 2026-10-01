FROM docker.io/library/archlinux:latest
ARG GNOME=
RUN pacman -Syu --noconfirm pipewire wireplumber pipewire-pulse libpulse dbus python \
    && if [ -n "$GNOME" ]; then pacman -S --noconfirm gnome-shell mesa; fi \
    && pacman -Scc --noconfirm

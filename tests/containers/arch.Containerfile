FROM docker.io/library/archlinux:latest
RUN pacman -Syu --noconfirm pipewire wireplumber pipewire-pulse libpulse dbus python \
    && pacman -Scc --noconfirm

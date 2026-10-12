ARG RELEASE=44
FROM registry.fedoraproject.org/fedora:${RELEASE}
ARG GNOME=
ARG KDE=
# Rootless containers can't run a program that carries file capabilities, and
# kwin_wayland has one. Rewriting the file in place drops it.
RUN dnf -y install pipewire wireplumber pipewire-pulseaudio pipewire-utils \
        pulseaudio-utils dbus-daemon python3 coreutils \
    && if [ -n "$GNOME" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install gnome-shell mesa-dri-drivers dconf; fi \
    && if [ -n "$KDE" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install kwin gjs libadwaita gtk4-layer-shell at-spi2-core mesa-dri-drivers libglvnd-gles \
        && cp /usr/bin/kwin_wayland /tmp/kwin && cat /tmp/kwin >/usr/bin/kwin_wayland && rm /tmp/kwin; fi \
    && dnf clean all

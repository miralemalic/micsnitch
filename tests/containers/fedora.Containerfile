ARG RELEASE=44
FROM registry.fedoraproject.org/fedora:${RELEASE}
ARG GNOME=
ARG KDE=
ARG SWAY=
# Rootless containers can't run a program that carries file capabilities, and
# kwin_wayland and sway have one. Rewriting the file in place drops it.
RUN dnf -y install pipewire wireplumber pipewire-pulseaudio pipewire-utils \
        pulseaudio-utils dbus-daemon python3 coreutils \
    && if [ -n "$GNOME" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install gnome-shell mesa-dri-drivers dconf; fi \
    && if [ -n "$KDE" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install kwin gjs libadwaita gtk4-layer-shell at-spi2-core mesa-dri-drivers libglvnd-gles \
        && cp /usr/bin/kwin_wayland /tmp/kwin && cat /tmp/kwin >/usr/bin/kwin_wayland && rm /tmp/kwin; fi \
    && if [ -n "$SWAY" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install $SWAY swaylock gjs libadwaita gtk4-layer-shell at-spi2-core mesa-dri-drivers libglvnd-gles \
        && for bin in $SWAY; do cp /usr/bin/$bin /tmp/bin && cat /tmp/bin >/usr/bin/$bin && rm /tmp/bin; done; fi \
    && dnf clean all

ARG RELEASE=44
FROM registry.fedoraproject.org/fedora:${RELEASE}
ARG GNOME=
RUN dnf -y install pipewire wireplumber pipewire-pulseaudio pipewire-utils \
        pulseaudio-utils dbus-daemon python3 coreutils \
    && if [ -n "$GNOME" ]; then dnf -y --setopt=install_weak_deps=False --disablerepo="*openh264*" \
        install gnome-shell mesa-dri-drivers dconf; fi \
    && dnf clean all

ARG RELEASE=44
FROM registry.fedoraproject.org/fedora:${RELEASE}
RUN dnf -y install pipewire wireplumber pipewire-pulseaudio pipewire-utils \
        pulseaudio-utils dbus-daemon python3 coreutils && dnf clean all

# MicSnitch

Asks before an app records your microphone or system audio.

MicSnitch holds the audio connection while a GNOME Shell popup asks for your
answer. Allow lets that recording through; Deny sends the app an error. You
can remember either answer, separately for microphone and system audio.

```text
Allow ChatGPT to use the microphone?
Built-in Microphone
☐ Remember for ChatGPT
                                  [ Deny ]  [ Allow ]
```

## Install

You need Linux with PipeWire **1.2 or newer** and WirePlumber **0.5.8 or
newer**. The popup supports **GNOME 50** and uses `pw-metadata` and `stdbuf`.

```sh
git clone https://github.com/miralemalic/micsnitch
cd micsnitch
tools/install.sh
```

Everything is installed for your user; no root access is needed. Audio
services restart briefly. Log out and back in once to load the popup.

`--no-restart` installs the files without restarting audio. Use
`--no-extension` to install just the policy. On other desktops or unsupported
GNOME versions, the installer skips the popup automatically.

Without a popup, requests wait for 15 seconds and are then denied. While the
screen is locked, requests wait until you unlock it; the controls and consent
popup are removed. Timeout denials are logged by WirePlumber; desktop
notifications require its notifications plugin, available since **0.5.12**.

```sh
tools/uninstall.sh
```

The uninstaller removes the policy, popup and recent activity, then restarts
audio. It also accepts `--no-restart`. Saved permission preferences remain
in GSettings. WirePlumber 0.4, shipped by Ubuntu 24.04 and Debian 12, is not
supported.

## Recording controls

Open the Microphone menu in GNOME Quick Settings to see who is recording,
what they are recording, and the source. Each recording has a **Stop** button.
Only active audio connections appear; allowing a request alone does not count
as recording. The microphone switch stops all recordings and blocks new ones.

Stop disconnects that recording and removes its approval. Other recordings
continue. If the app starts another recording, it asks again unless a
remembered rule answers it. Stop does not erase saved rules; edit those in
the extension's preferences.

The menu also shows the last 10 decisions observed while the extension is
enabled, including recordings stopped from the menu. The list is saved privately
in `$XDG_RUNTIME_DIR/micsnitch-activity.json`, and contains no audio. It survives
lock/unlock and audio-service restarts, and resets for a new login. Restarting
GNOME Shell may also reset it. No decision history is published through
PipeWire. Like other user files, it is accessible to software running with your
user's permissions.

## How it works

The WirePlumber script holds connections that would feed an app audio owned
by another client: a microphone, speaker audio, or another app's sound fed
into a virtual device. The GNOME extension shows requests and remembers
answers. They communicate through a PipeWire metadata object called
`micsnitch`, containing pending requests and current recording status.

Approvals belong to one recording stream and one audio type. Allowing speaker
audio does not let that stream switch to the microphone without asking.
WirePlumber's live status disappears if it stops, so the menu can show when
the policy is unavailable.

## Identity and limits

MicSnitch is a consent tool, not a sandbox. Software running as your user can
change the metadata or audio configuration, open the sound card directly
through ALSA, or race the initial permission setup. A raced link is cut when
found, but some sound may already have flowed. Run software you do not trust
in a sandbox without audio access.

Native PipeWire clients are identified using kernel-supplied process
information. For scripts, the program may be an interpreter such as python3.
PulseAudio clients supply their own names, which cannot be verified. Their
remembered rules use the app name shown in the checkbox, so Slack and ChatGPT
do not share a rule merely because both use `electron`. An app can still
deliberately claim another app's name; the popup explains this limitation.

MicSnitch removes the link-factory from ordinary clients. Patchbays such as
qpwgraph and Helvum, and JACK apps that make their own links, cannot freely
connect ports. PulseAudio module loading is disabled to prevent loopbacks
from routing audio around the policy.

## Tests

The tests use private containers with a fake microphone and a separate
GNOME Shell, so they do not use your audio devices. They require Podman.

```sh
tests/matrix.sh
tests/container.sh fedora44 tests/run.sh
tests/popup.sh shots/
```

## License

GPL-3.0-or-later.

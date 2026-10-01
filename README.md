# MicSnitch

**Nothing listens until you say so.**

Any program you run can open your microphone without a word. Most never will.
MicSnitch is for the ones that might.

Every attempt to record, whether your microphone or whatever your speakers are
playing, is stopped at the door and brought to you. You decide. Nothing crosses
in the meantime.

```text
Allow Discord to use the microphone?
Built-in Microphone
☐ Remember for anything calling itself Discord
                                  [ Deny ]  [ Allow ]
```

## Works on

GNOME **48 to 51**, PipeWire **1.2+** and WirePlumber **0.5.8+**.

| Tested on    | GNOME     | WirePlumber | PipeWire |
|--------------|-----------|-------------|----------|
| Fedora 45    | 51.0      | 0.5.18      | 1.6.9    |
| Fedora 44    | 50.5      | 0.5.17      | 1.6.9    |
| Fedora 43    | 49.10     | 0.5.14      | 1.4.11   |
| Ubuntu 26.04 | 50.1      | 0.5.13      | 1.6.2    |
| Debian 13    | 48.7      | 0.5.8       | 1.4.2    |
| Arch         | gate only | 0.5.17      | 1.6.9    |

Each one runs the tests in a container with a fake microphone, and the GNOME
ones in a GNOME Shell no one can see. MicSnitch also runs on real hardware every
day, on Fedora 44. Other distros with these versions should hold up too, think
openSUSE Tumbleweed, Manjaro or EndeavourOS, but nobody has checked yet.

Out of reach: Ubuntu 24.04, Debian 12 and Linux Mint 22 ship WirePlumber 0.4,
which works differently. KDE and other desktops have no handler yet. And on
WirePlumber older than 0.5.12, Debian 13 included, a request that times out is
refused without a notification.

## The setup

Two parts, one job.

- **The gate** lives inside WirePlumber, where every audio connection on the
  system is made. A request to listen is held there before a single sample
  moves.
- **The handler** is a GNOME Shell extension. It puts the question in front of
  you, carries your answer back and keeps the log.

They speak through a PipeWire metadata object called `micsnitch`. To watch the
wire: `pw-metadata -m -n micsnitch`.

## Rules of engagement

- **Allow** opens the line for that one recording. The next one asks again.
- **Deny** cuts it and hands the app an error.
- **Remember** turns an answer into standing orders, for the microphone and
  system audio separately. Revoke them in the settings.
- An app that knocks again within 30 seconds of your answer gets the same
  answer. Chromium-based apps knock three times for every click; you hear it
  once.
- The **MicSnitch** tile in Quick Settings shows who is listening right now,
  with a **Stop** for each. Switch the tile off and every line goes dead at
  once. If the gate ever goes down, the tile shows a warning.
- **Recent activity** holds the latest decisions: ten in the menu, fifty in the
  settings, none from before this login and never any audio. An allow or deny
  there can be taken back with **Undo**.
- On a locked screen, requests wait for you. Nothing is approved behind your
  back. With no handler at all, the answer after 15 seconds is no.

## Field limits

MicSnitch is a checkpoint, not a vault. Know where its walls end.

- Most apps reach the sound system through PulseAudio, and there they name
  themselves. Anything can claim to be Discord, which is why the popup says
  "anything calling itself". Apps that talk to PipeWire directly are named by
  the kernel, down to the program on disk. For a script, that's its
  interpreter, python3 and all.
- Code running as you and built to beat MicSnitch can forge an answer, rewrite
  the configuration or open the sound card directly through ALSA. A link
  raced in the instant an app connects is cut on sight, but a few milliseconds
  may already have slipped through. Untrusted software belongs in a sandbox
  without a microphone.
- Apps lose PipeWire's link-factory, so patchbays like qpwgraph and Helvum,
  and JACK apps that wire their own ports, can't. Loading PulseAudio modules is
  switched off too: a loopback would be a tunnel under the gate.

## Install

```sh
git clone https://github.com/miralemalic/micsnitch
cd micsnitch
tools/install.sh
```

Everything goes into your own account, no root needed. Audio drops for a
second, so not mid-call. Log out and back in to bring the handler online. To
update, `git pull` and run `tools/install.sh` again.

Without a supported GNOME the installer refuses: no handler means nothing could
ever be allowed. `--no-extension` installs the gate alone if that's what you
want, and `--no-restart` leaves the audio running until you restart it
yourself.

MicSnitch isn't on extensions.gnome.org. The site can only ship the handler,
and the handler is nothing without the gate.

To remove every trace of the gate, the handler and the log:

```sh
tools/uninstall.sh
```

Remembered answers stay in GSettings.

## Tests

Every test runs in a container with its own PipeWire, a fake microphone
playing a tone and, for the popup, a GNOME Shell no one can see. Your desktop
and your devices are never touched. Podman required.

```sh
tests/matrix.sh                          # the gate, on every distro
tests/container.sh fedora44 tests/run.sh # the gate, on one
tests/popup.sh fedora44                  # the handler, on GNOME 50
tests/harness.sh                         # the tests, tested
```

`debian13` has GNOME 48, `fedora43` 49, `fedora44` 50 and `fedora45` 51.

## License

MIT. See [LICENSE](LICENSE).

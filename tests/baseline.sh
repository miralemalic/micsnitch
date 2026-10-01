#!/bin/bash
# Check that the private rig works without MicSnitch:
#   MICSNITCH=0 tests/container.sh fedora44 tests/baseline.sh
# shellcheck source=tests/lib.sh
. "$(dirname "$0")/lib.sh"
feed_fake_mic
record /tmp/mic.wav fake-mic
check "the mic recorder stays alive" "$?" 124
check "fake mic records the tone" "$(sound_of /tmp/mic.wav)" sound
record /tmp/monitor.wav fake-mic.feed
check "the monitor recorder stays alive" "$?" 124
check "sink monitor records the tone" "$(sound_of /tmp/monitor.wav)" sound
# shellcheck disable=SC2119
check "without MicSnitch apps can wire ports" "$(self_wire)" linked

# Without MicSnitch the sneaked-in link really is there
start_app
read -r on op _ < <(port_of fake-mic output)
read -r inn ip _ < <(port_of evil input)
pw-metadata -n default 0 micsnitch.test.link "$on $op $inn $ip" >/dev/null
sleep 0.5
check "the privileged fixture creates a real link" \
    "$(linked fake-mic:capture_FL evil:playback_FL && echo linked || echo missing)" linked
stop_app
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

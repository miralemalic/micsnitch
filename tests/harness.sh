#!/bin/bash
# Checks that the harness cannot turn missing evidence or a failed container
# into a passing policy result. No audio services are started.
set -u
cd "$(dirname "$0")/.." || exit 1
. tests/lib.sh
scratch=$(mktemp -d)
trap 'rm -rf "${scratch:?}"' EXIT

sound=$(sound_of "$scratch/missing.wav")
check 'missing audio is reported as invalid' "$sound" 'invalid recording'
sound_of "$scratch/missing.wav" >/dev/null
check 'the missing-file detector fails' "$?" 1
printf 'broken file\n' >"$scratch/broken.wav"
sound=$(sound_of "$scratch/broken.wav")
check 'corrupt audio is reported as invalid' "$sound" 'invalid recording'

mkdir "$scratch/bin"
cat >"$scratch/bin/pw-record" <<'RECORDER'
#!/bin/sh
exit 7
RECORDER
cat >"$scratch/bin/podman" <<'CONTAINER'
#!/bin/sh
if [ "$1" = image ] && [ "$2" = exists ]; then exit 0; fi
printf '%s\n' "${RIG_RESULT:-99 passed, 0 failed}"
exit "${RIG_EXIT:-42}"
CONTAINER
chmod +x "$scratch/bin/pw-record" "$scratch/bin/podman"
PATH=$scratch/bin:$PATH record "$scratch/test.wav"
check 'recorder failures are not swallowed' "$?" 7
PATH=$scratch/bin:$PATH RIG_EXIT=42 tests/matrix.sh fedora44 >/dev/null
check 'a failing container cannot pass on its printed summary' "$?" 1
PATH=$scratch/bin:$PATH RIG_EXIT=0 RIG_RESULT='99 passed, 1 failed' tests/matrix.sh fedora44 >/dev/null
check 'a failing summary is not ignored' "$?" 1
PATH=$scratch/bin:$PATH RIG_EXIT=0 tests/matrix.sh fedora44 >/dev/null
check 'a successful container with a clean summary passes' "$?" 0

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

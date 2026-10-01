#!/bin/bash
# Runs the policy tests on each supported distribution.
cd "$(dirname "$0")/.." || exit 1
status=0
distros=("$@")
[ $# -gt 0 ] || distros=(fedora44 fedora43 ubuntu2604 debian13 arch)
for distro in "${distros[@]}"; do
    result=$(tests/container.sh "$distro" bash -c \
        'wireplumber --version; tests/run.sh' 2>&1)
    code=$?
    printf '%-12s %s (exit %s)\n' "$distro" "$(tail -1 <<<"$result")" "$code"
    if [ "$code" != 0 ] || [[ $result != *" 0 failed" ]]; then
        printf '%s\n' "$result"
        status=1
    fi
done
exit "$status"

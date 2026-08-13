#!/usr/bin/env bash
# Echoes the raw mouse bytes it receives, which is how the wire encoding is verified end to end.
#
# No `set -euo pipefail`, unlike install.sh: `stty` legitimately fails when there is no controlling
# terminal, and under `set -e` that would abort before the READY line the test waits for. The
# redirect below says the failure is expected.
printf '\033[?1000h\033[?1002h\033[?1006h'
stty raw -echo 2>/dev/null
printf 'MOUSE ECHO READY\r\n'
exec cat -v

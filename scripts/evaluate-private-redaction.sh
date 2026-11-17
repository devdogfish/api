#!/bin/sh
# Launch with network denied before opening the Owner manifest.
set -eu
if [ "$#" -lt 2 ] || [ ! -x /usr/bin/sandbox-exec ]; then
  printf '%s\n' '{"errors":1}'
  exit 1
fi
python=$1
shift
script=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/evaluate-private-redaction.py
status=0
report=$(/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  "$python" -IB "$script" "$@" 2>/dev/null) || status=$?
if [ -z "$report" ]; then
  printf '%s\n' '{"errors":1}'
  exit 1
fi
printf '%s\n' "$report"
exit "$status"

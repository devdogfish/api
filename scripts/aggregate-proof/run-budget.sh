#!/bin/sh
# Execute one command in a fresh cgroup v2 proof container.
set -eu

test "$#" -gt 0
for key in memory.max memory.swap.max cpu.max; do
  printf '%s=' "$key"
  cat "/sys/fs/cgroup/$key"
done
test "$(cat /sys/fs/cgroup/memory.max)" = 6442450944
test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
test "$(cat /sys/fs/cgroup/cpu.max)" = '200000 100000'

status=0
timeout --kill-after=15s 240s "$@" || status=$?
printf 'cgroup_peak_bytes='
cat /sys/fs/cgroup/memory.peak
cat /sys/fs/cgroup/memory.events
awk '
  $1 == "oom" { oom = $2; saw_oom = 1 }
  $1 == "oom_kill" { killed = $2; saw_kill = 1 }
  END { exit !(saw_oom && saw_kill && oom == 0 && killed == 0) }
' /sys/fs/cgroup/memory.events
exit "$status"

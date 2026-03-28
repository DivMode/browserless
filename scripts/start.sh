#!/bin/bash
set -e

# When docker restarts, this file is still there,
# so we need to kill it just in case
[ -f /tmp/.X99-lock ] && rm -f /tmp/.X99-lock

_kill_procs() {
  kill -TERM $app
  kill -TERM $xvfb
  [ ! -z "$monitor_pid" ] && kill -TERM $monitor_pid 2>/dev/null
}

# Relay quit commands to processes
trap _kill_procs SIGTERM SIGINT

if [ -z "$DISPLAY" ]
then
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp +extension RANDR >/dev/null 2>&1 &
  xvfb=$!
  export DISPLAY=:99
fi

# Monitor Xvfb health — restart if it dies
_xvfb_monitor() {
  while true; do
    sleep 10
    if [ ! -z "$xvfb" ] && ! kill -0 $xvfb 2>/dev/null; then
      echo "[$(date -u +%FT%T.%3NZ)] ERROR: Xvfb process $xvfb died, restarting" >&2
      [ -f /tmp/.X99-lock ] && rm -f /tmp/.X99-lock
      Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp +extension RANDR >/dev/null 2>&1 &
      xvfb=$!
      echo "[$(date -u +%FT%T.%3NZ)] INFO: Xvfb restarted as PID $xvfb" >&2
    fi
  done
}
_xvfb_monitor &
monitor_pid=$!

dumb-init -- node build/index.js $@ &
app=$!

wait $app

if [ ! -z "$xvfb" ]
then
  wait $xvfb
fi

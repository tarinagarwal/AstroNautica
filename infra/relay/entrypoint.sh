#!/bin/sh
# Starts strfry and scrubs IP addresses out of everything it prints (spec §12:
# no IP logging). strfry writes a "Connect from <ip>" style line per websocket
# and has no option to turn that off, so every IPv4/IPv6 address in its output
# is replaced (scrub-ips.js) before it reaches the container log. Production
# also runs the container with the `none` log driver as a second line of defence.
set -eu

mkdir -p /app/strfry-db

# Optional: stream events down from upstream relays. STREAMS is a
# comma-separated list of full relay URLs (wss://... or ws://...); the mirror
# kit uses this to follow the official relays.
if [ -n "${STREAMS:-}" ]; then
  for upstream in $(echo "$STREAMS" | tr ',' ' '); do
    ( sleep 2; exec /app/strfry stream "$upstream" --dir down ) 2>&1 | node /app/scrub-ips.js &
  done
fi

# strfry runs inside a pipeline, so it is not PID 1: forward signals explicitly.
/app/strfry relay 2>&1 | node /app/scrub-ips.js &
PIPE_PID=$!

term() {
  pkill -TERM -x strfry 2>/dev/null || true
}
trap term TERM INT
wait "$PIPE_PID" || true
# If we were signalled, wait for strfry to finish flushing LMDB.
while pgrep -x strfry >/dev/null 2>&1; do sleep 0.2; done

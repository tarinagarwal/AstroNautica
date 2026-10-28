#!/bin/sh
# Starts strfry and scrubs IP addresses out of everything it prints (spec §12:
# no IP logging). strfry writes a "Connect from <ip>" style line per websocket
# and has no option to turn that off, so every IPv4/IPv6 address in its output
# is replaced (scrub-ips.js) before it reaches the container log. Production
# also runs the container with the `none` log driver as a second line of defence.
set -eu

mkdir -p /app/strfry-db

# Write policy: learn the owner's moderators and publisher keys before strfry
# starts (infra/relay/policy.js). Fails here if OWNER_PUBKEY is malformed.
OWNER_HEX=$(node /app/azaad-policy.js --owner-hex)
if [ -n "$OWNER_HEX" ]; then
  # Optional bootstrap: a JSON array of owner list events. `strfry import`
  # verifies every signature (the plugin itself trusts only what strfry checked).
  if [ -n "${BOOTSTRAP_LIST_EVENTS_FILE:-}" ]; then
    node /app/azaad-policy.js --bootstrap-lines "$BOOTSTRAP_LIST_EVENTS_FILE" | /app/strfry import 2>/dev/null
  fi
  # Replay the owner's moderators / service-keys lists already in the database
  # into the policy state file (POLICY_STATE_FILE), so nothing is lost if the
  # state file is missing or older than the database.
  /app/strfry scan \
    "{\"kinds\":[30078],\"authors\":[\"$OWNER_HEX\"],\"#d\":[\"azaad:list:moderators\",\"azaad:list:service-keys\"]}" \
    2>/dev/null | node /app/azaad-policy.js --ingest -
fi

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

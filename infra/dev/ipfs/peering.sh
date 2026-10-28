#!/bin/sh
# Peers ipfs-a and ipfs-b with each other, both at runtime (swarm peering add)
# and persistently (Peering.Peers in each node's config), so content added on
# one node is fetched from the other over bitswap without any public routing.
# Then stays up, re-checking every 30 s and re-peering if a node was restarted
# or reset (new peer ID). Healthy once /tmp/peered exists. Any failure exits
# non-zero and the container restarts and tries again.
set -eu

A=/dns4/ipfs-a/tcp/5001
B=/dns4/ipfs-b/tcp/5001

wait_for() {
  i=0
  until ipfs --api "$1" id >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "timed out waiting for $1" >&2; exit 1; }
    sleep 1
  done
}

peer() {
  wait_for "$A"
  wait_for "$B"
  A_ID=$(ipfs --api "$A" id -f '<id>')
  B_ID=$(ipfs --api "$B" id -f '<id>')

  ipfs --api "$A" config --json Peering.Peers "[{\"ID\":\"$B_ID\",\"Addrs\":[\"/dns4/ipfs-b/tcp/4001\"]}]"
  ipfs --api "$B" config --json Peering.Peers "[{\"ID\":\"$A_ID\",\"Addrs\":[\"/dns4/ipfs-a/tcp/4001\"]}]"
  ipfs --api "$A" swarm peering add "/dns4/ipfs-b/tcp/4001/p2p/$B_ID" >/dev/null || true
  ipfs --api "$B" swarm peering add "/dns4/ipfs-a/tcp/4001/p2p/$A_ID" >/dev/null || true

  i=0
  until ipfs --api "$A" swarm peers | grep -q "$B_ID"; do
    i=$((i + 1))
    [ "$i" -gt 30 ] && { echo "ipfs-a did not connect to ipfs-b" >&2; exit 1; }
    ipfs --api "$A" swarm connect "/dns4/ipfs-b/tcp/4001/p2p/$B_ID" >/dev/null 2>&1 || true
    sleep 1
  done
  echo "peered: ipfs-a=$A_ID <-> ipfs-b=$B_ID"
}

peered() {
  b_id=$(ipfs --api "$B" id -f '<id>' 2>/dev/null) || return 1
  ipfs --api "$A" swarm peers 2>/dev/null | grep -q "$b_id"
}

peer
touch /tmp/peered

while true; do
  sleep 30
  if ! peered; then
    rm -f /tmp/peered
    peer
    touch /tmp/peered
  fi
done

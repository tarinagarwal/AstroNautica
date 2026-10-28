#!/bin/sh
# Kubo configuration for an AzaadAwaaz pinning node (spec §11: "Kubo nodes that
# pin everything"). Runs on every container start; idempotent.
set -eu

# Datacenter defaults: no LAN discovery, no dialling private address ranges.
ipfs config profile apply server >/dev/null

# CIDv1 for everything we add.
ipfs config --json Import.CidVersion 1

# The gateway serves only what this node already has (what we pin). It is
# reached through nginx (https://ipfs.<domain>) and never logs requests.
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.NoDNSLink true
ipfs config --json Gateway.ExposeRoutingAPI false
# Anything served from a CID is untrusted content: sandbox it so HTML/SVG can never run with the gateway origin
# (applies to mirrors too, which expose this gateway without nginx in front).
ipfs config --json Gateway.HTTPHeaders '{"Content-Security-Policy":["sandbox; default-src '"'"'none'"'"'"],"X-Content-Type-Options":["nosniff"]}'

# Announce everything we pin so public gateways can find it.
ipfs config Provide.Strategy all 2>/dev/null || ipfs config Reprovider.Strategy all

ipfs config Datastore.StorageMax "${IPFS_STORAGE_MAX:-500GB}"

# The RPC API (port 5001) controls the node (add, pin, rm, config, shutdown). When
# IPFS_API_LISTEN is set (comma-separated multiaddrs), it listens only there:
# infra/prod binds it to loopback (healthcheck) and the node's fixed address on the
# internal `ipfsrpc` network that only the publisher shares. Unset (the mirror kit),
# the image default stays.
if [ -n "${IPFS_API_LISTEN:-}" ]; then
  api_json=$(printf '%s' "$IPFS_API_LISTEN" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? "," : "["), $i; print "]" }')
  ipfs config --json Addresses.API "$api_json"
fi

# Optional fixed peering with our other IPFS nodes (other countries) and
# mirrors: JSON array of {"ID": "...", "Addrs": ["..."]}.
if [ -n "${IPFS_PEERING:-}" ]; then
  ipfs config --json Peering.Peers "$IPFS_PEERING"
fi

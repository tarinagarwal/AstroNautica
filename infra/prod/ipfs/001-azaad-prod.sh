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

# Announce everything we pin so public gateways can find it.
ipfs config Provide.Strategy all 2>/dev/null || ipfs config Reprovider.Strategy all

ipfs config Datastore.StorageMax "${IPFS_STORAGE_MAX:-500GB}"

# Optional fixed peering with our other IPFS nodes (other countries) and
# mirrors: JSON array of {"ID": "...", "Addrs": ["..."]}.
if [ -n "${IPFS_PEERING:-}" ]; then
  ipfs config --json Peering.Peers "$IPFS_PEERING"
fi

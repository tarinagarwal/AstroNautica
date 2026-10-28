#!/bin/sh
# Kubo configuration for the AzaadAwaaz dev network. The kubo image runs every
# /container-init.d/*.sh on each start (after `ipfs init` on first start), so
# everything here is idempotent.
set -eu

# CIDv1 (base32, raw leaves) for everything we add (spec §4, §6).
ipfs config --json Import.CidVersion 1

# Closed local network: no public bootstrap peers, no autoconf fetches from the
# internet, no delegated routers, no LAN multicast. ipfs-a and ipfs-b find each
# other through Peering (set by the ipfs-peering one-shot service).
ipfs config --json AutoConf.Enabled false
ipfs config --json Bootstrap '[]'
ipfs config --json Routing.DelegatedRouters '[]'
ipfs config --json Ipns.DelegatedPublishers '[]'
ipfs config --json DNS.Resolvers '{}'
ipfs config Routing.Type dht
ipfs config --json Discovery.MDNS.Enabled false

# Kubo has no gateway access log; keep it that way and do not expose the
# deprecated/peer-revealing endpoints on the gateway port.
ipfs config --json Gateway.NoDNSLink true
ipfs config --json Gateway.ExposeRoutingAPI false

# The web app's dev server (apps/web, Vite) talks to the RPC API from the
# browser. Dev only: production never exposes the RPC API.
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin \
  '["http://localhost:5173","http://127.0.0.1:5173","http://localhost:4173","http://127.0.0.1:4173"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'

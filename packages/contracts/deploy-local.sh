#!/usr/bin/env bash
# Deploys AzaadAwaazRegistry to an already-running RPC node and records the result in deployments/<chainId>.json.
# It does not start a node. Defaults target a local anvil:
#   RPC_URL      default http://127.0.0.1:8545 (or pass as the first argument)
#   PRIVATE_KEY  default anvil account #0
#   OWNER        default anvil account #0
#   PUBLISHER    default anvil account #1
set -euo pipefail

cd "$(dirname "$0")"

RPC_URL="${1:-${RPC_URL:-http://127.0.0.1:8545}}"
ANVIL_KEY0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PRIVATE_KEY="${PRIVATE_KEY:-$ANVIL_KEY0}"
OWNER="${OWNER:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
PUBLISHER="${PUBLISHER:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
export OWNER PUBLISHER

for tool in forge cast; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH" >&2; exit 1; }
done

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
echo "Deploying to chainId $CHAIN_ID via $RPC_URL (owner $OWNER, publisher $PUBLISHER)"

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --non-interactive >/dev/null

RUN_FILE="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
[ -f "$RUN_FILE" ] || { echo "error: $RUN_FILE not found" >&2; exit 1; }

# Read the broadcast record with node (always present in this monorepo) to avoid a jq dependency.
read -r ADDRESS TX_HASH < <(node -e '
  const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const tx = run.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === "AzaadAwaazRegistry");
  if (!tx) { console.error("no AzaadAwaazRegistry CREATE in broadcast"); process.exit(1); }
  console.log(tx.contractAddress, tx.hash);
' "$RUN_FILE")

ADDRESS="$(cast to-check-sum-address "$ADDRESS")"
RECEIPT_BLOCK="$(cast receipt "$TX_HASH" blockNumber --rpc-url "$RPC_URL")"
CODE="$(cast code "$ADDRESS" --rpc-url "$RPC_URL")"
[ "$CODE" != "0x" ] || { echo "error: no code at $ADDRESS" >&2; exit 1; }

mkdir -p deployments
OUT="deployments/$CHAIN_ID.json"
cat > "$OUT" <<JSON
{
  "contract": "AzaadAwaazRegistry",
  "chainId": $CHAIN_ID,
  "address": "$ADDRESS",
  "owner": "$(cast to-check-sum-address "$OWNER")",
  "publisher": "$(cast to-check-sum-address "$PUBLISHER")",
  "transactionHash": "$TX_HASH",
  "blockNumber": $RECEIPT_BLOCK,
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "AzaadAwaazRegistry deployed at $ADDRESS on chainId $CHAIN_ID"
echo "Wrote $OUT"

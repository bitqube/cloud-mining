#!/usr/bin/env bash
# Sweeps the BTQ customers paid into the node's wallet out to a cold address. Run it by
# hand on the node's server, e.g. weekly:
#
#   scripts/btq-sweep.sh <destination address> [min confirmations, default 6]
#
# Shows what will be sent and asks before sending. The wallet passphrase is read from
# the terminal and handed to bitqube-cli on stdin, so it never appears in the shell
# history or the process list. The wallet is locked again straight after.
#
# Each order pays into its own address, so the wallet holds one coin per payment. A
# transaction can only spend so many coins (about 600), so they go out in batches of
# BATCH, one transaction each, all to the same destination, fee taken from the amount.
#
# Needs python3 (for JSON). Set BITQUBE_CLI to the full command if bitqube-cli needs
# flags, for example
#   BITQUBE_CLI="bitqube-cli -datadir=/var/lib/bitqube" scripts/btq-sweep.sh B...
set -euo pipefail

DEST="${1:?usage: $0 <destination address> [min confirmations]}"
MINCONF="${2:-6}"
BATCH="${BATCH:-400}"
read -r -a CLI <<<"${BITQUBE_CLI:-bitqube-cli}"
cli() { "${CLI[@]}" "$@"; }
die() {
  echo "error: $*" >&2
  exit 1
}

cli validateaddress "$DEST" | grep -q '"isvalid": true' || die "$DEST is not a valid BitQube address"
if cli validateaddress "$DEST" | grep -q '"ismine": true'; then
  die "$DEST belongs to this wallet; sweep to an address outside the server"
fi

# The wallet can list coins it already spent until it rescans, which makes sends fail.
echo "Rescanning the chain for wallet transactions..."
cli rescanblockchain >/dev/null

# Spendable coins with enough confirmations, each double-checked against the UTXO set,
# grouped into batches: one line per batch, "<inputs JSON> TAB <total>".
PLAN="$(mktemp)"
trap 'rm -f "$PLAN"' EXIT
python3 - "$MINCONF" "$BATCH" "${CLI[@]}" >"$PLAN" <<'PY' || die "could not list the wallet's coins"
import json, subprocess, sys
from decimal import Decimal
minconf, size, cli = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, check=True).stdout.strip()
live = []
for c in json.loads(run("listunspent", minconf), parse_float=Decimal):
    if c.get("spendable", True) and run("gettxout", c["txid"], str(c["vout"])):  # empty = already spent on chain
        live.append(c)
for i in range(0, len(live), size):
    chunk = live[i:i + size]
    total = sum(c["amount"] for c in chunk)
    print(json.dumps([{"txid": c["txid"], "vout": c["vout"]} for c in chunk]) + "\t" + format(total.quantize(Decimal("0.00000001")), "f"))
PY
mapfile -t BATCHES <"$PLAN"

TOTAL=0
for b in "${BATCHES[@]}"; do TOTAL="$(python3 -c "from decimal import Decimal as D; print(D('$TOTAL') + D('${b##*$'\t'}'))")"; done
echo
echo "Wallet balance:        $(cli getbalance "*" 0) BTQ (including unconfirmed)"
echo "Sweepable now:         $TOTAL BTQ ($MINCONF+ confirmations), in ${#BATCHES[@]} transaction(s)"
echo "Destination:           $DEST"
echo "The network fee is taken out of the amount sent."
echo

[[ ${#BATCHES[@]} -gt 0 ]] || die "nothing to sweep"
read -r -p "Send $TOTAL BTQ to $DEST? Type yes to continue: " ok
[[ "$ok" == "yes" ]] || die "cancelled"

read -r -s -p "Wallet passphrase: " PASS
echo
trap 'cli walletlock >/dev/null 2>&1 || true; rm -f "$PLAN"' EXIT
printf '%s\n%s\n' "$PASS" 300 | cli -stdin walletpassphrase >/dev/null || die "wrong passphrase"
unset PASS

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
for b in "${BATCHES[@]}"; do
  inputs="${b%%$'\t'*}"
  amount="${b##*$'\t'}"
  raw="$(cli createrawtransaction "$inputs" "{\"$DEST\": $amount}")"
  # The inputs exactly cover the output, so funding only takes the fee out of it.
  funded="$(cli fundrawtransaction "$raw" '{"subtractFeeFromOutputs": [0]}' | json '["hex"]')"
  signed="$(cli signrawtransaction "$funded")"
  [[ "$(json '["complete"]' <<<"$signed")" == "True" ]] || die "could not sign a batch: $signed"
  txid="$(cli sendrawtransaction "$(json '["hex"]' <<<"$signed")")"
  echo "Sent $amount BTQ (before fee) in $txid"
done
cli walletlock
echo "Remaining (unconfirmed or newer than $MINCONF blocks): $(cli getbalance "*" 0) BTQ"

# BTQ payments

Customers can pay in BTQ. Each order gets its own deposit address from the BitQube node's
wallet. The worker watches those addresses and marks the order paid once the full amount
has the required confirmations. The coins stay in the node's wallet until an admin sweeps
them out with `scripts/btq-sweep.sh`.

## How a BTQ order works

1. **Checkout.** The customer chooses how much of the price to pay in BTQ (up to `btq.maxSharePct`); that part is converted at the BTQ price set in Admin → BTQ and rounded up to 0.01 BTQ. The rest is paid by card or USDT.
   - The node issues a new address, labelled `order <order id>` in its wallet.
   - The customer has the payment window (default 60 minutes) to send the amount.
2. **Payment seen.** The worker checks the node every tick (30 s). Once the payment is in the mempool, the order page shows confirmation progress and the order is no longer cancelled for non-payment.
3. **Paid.** At **btq.confirmations** (default 6, about 6 minutes) the order becomes PAID and the worker rents the hashrate as for any other payment.

### Cases that go to an admin

| Case | What happens |
| --- | --- |
| Short payment (below 99.5%) when the window closes | Admin alert. The customer can top up while the window is open. |
| Payment first seen after the window, or for a cancelled order | Admin alert. Not started automatically, because the locked price may no longer cover the hashrate. |
| Overpayment | Order is started, plus an admin alert so the difference can be refunded. |
| A confirmed payment disappears (reorg or double spend) | Admin alert, for 48 hours after confirming. Check the order and stop its rentals if needed. |

For a late or short payment, open the order in Admin and use **Accept BTQ payment** if it's acceptable. Otherwise refund it from the node's wallet.

### Why there is a per-order cap

The BitQube network is small, about 1 GH/s, and renting that much hashrate on MRR costs only a few dollars an hour. Someone could pay, wait for the confirmations, then rewrite those blocks to take the payment back after rigs were rented.

**Largest BTQ order** (default $200) limits what one such reversal can cost, and the reversal alert above catches it. Raise the cap as the network grows.

## Node setup

Run the node on its own droplet with the wallet enabled. The app only calls `getnewaddress`, `listreceivedbyaddress` and `getreceivedbyaddress`; it never sends.

`bitqube.conf`:

```ini
server=1
# Enough pre-generated addresses that the wallet never needs unlocking to hand one out.
keypool=10000
# RPC over the private network only (VPC 10.104.0.0/20): node 10.104.0.3, app droplet 10.104.0.4.
rpcbind=127.0.0.1
rpcbind=10.104.0.3
rpcallowip=127.0.0.1
rpcallowip=10.104.0.4/32
rpcport=37171
# A hashed login; the matching plain password goes only in the app's .env (see below).
rpcauth=bqcloud:<salt>$<hash>
```

Generate the `rpcauth` line and its password, then remove any `rpcuser`/`rpcpassword` lines:

```sh
python3 -c 'import hmac,secrets; s=secrets.token_hex(16); p=secrets.token_urlsafe(32); print("rpcauth=bqcloud:"+s+"$"+hmac.new(s.encode(),p.encode(),"sha256").hexdigest()); print("BTQ_RPC_PASSWORD="+p)'
```

`addressindex` isn't needed for payments, because the wallet tracks its own addresses. It does no harm if it's already on.

Then, once:

1. **Encrypt the wallet:** `bitqube-cli encryptwallet "<long passphrase>"`, then restart the node.
   - Encrypting creates a new HD seed, so any backup made before this point is useless.
   - Keep the passphrase off the server. Only the sweep needs it.
2. **Back up `wallet.dat` offline.** One backup taken after encrypting covers every future deposit address.
3. **Firewall** (DigitalOcean Cloud Firewall on the node droplet): allow the RPC port only from the app droplet, P2P (8851) from anywhere, and SSH from admins only.
4. **App `.env`:**
   - `BTQ_RPC_URL=http://10.104.0.3:37171/`
   - `BTQ_RPC_USER=bqcloud` and `BTQ_RPC_PASSWORD` from the rpcauth step.
5. **Admin → BTQ:** set the BTQ price and max share, then turn BTQ payments on. BTQ shows at checkout only when it is on, the price is above 0 and the RPC settings are present.

New addresses work while the wallet is locked until the keypool runs out. After about 10,000 BTQ orders, unlock the wallet once briefly to refill it: `bitqube-cli walletpassphrase "<pass>" 60 && bitqube-cli keypoolrefill 10000`. Check the remaining count with `getwalletinfo` (`keypoolsize`).

## Weekly sweep

On the node's server:

```sh
scripts/btq-sweep.sh <cold wallet address> [min confirmations, default 6]
```

The script:
1. Rescans the chain, because the wallet can list already-spent coins until it does, which makes sends fail.
   - Each coin is also checked against the UTXO set (`gettxout`) before it is used.
2. Shows the sweepable balance and asks you to type `yes`.
3. Reads the passphrase without echoing it and unlocks the wallet for at most 5 minutes.
4. Sends the coins in batches of 400, one transaction each, with the fee taken out of the amount.
   - Each payment is its own coin, and one transaction can spend only about 600.
5. Locks the wallet again.

Only coins with the minimum confirmations are swept; newer payments wait for the next run.

Sweeping does not disturb the payment watcher. It looks at what each address has received, not at what is still there.

It needs `python3` on the node's server, for JSON handling. It refuses an invalid address or one that belongs to the same wallet. Use `BITQUBE_CLI="bitqube-cli -datadir=..."` if the CLI needs flags.

To see which order paid what: `bitqube-cli listreceivedbyaddress 1` lists each address with its `order <id>` label, amount and txids. The order page in Admin shows the same.

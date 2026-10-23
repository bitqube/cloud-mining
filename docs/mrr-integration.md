# MiningRigRentals integration

MiningRigRentals (MRR) is the only hashrate provider (client decision, 2026-10-18). The source is the MRR API v2 docs (https://www.miningrigrentals.com/apidocv2), checked against the live API with the client's key on 2026-10-18. The code lives in `src/lib/mrr/` and `src/lib/providers/mrr.ts`.

## Verified live (2026-10-18)

- **Auth and key:** HMAC signing works. Account `Ithaya`; permissions are rent and rigs, withdraw **no**. `GET /account/balance` returns "No Permission" because Balance is set to None on the key.
- **Algorithm name** is `kawpow`. GET filters sent as a PHP-style query string (`rpi[min]=80`) are honoured.
- **Pool compatibility:** `PUT /account/pool/test` (full) against `pool.bitqube.org:10032` passes. connection, sub, auth, diffs and work are all true, red is false, and the starting diff is `215590515` = pool diff 0.05 × 2³². This confirms that pool difficulty 1 = 2³² hashes, the unit `optimal_diff` is compared in.
- **End to end:** rental #5821873 (rig 157289, 205 MH/s, 25h, paid 0.0093 ETH) was created by hand on the "Default - Last Used" profile (id **985841**). It points at `Pool.bitqube.org:10032` with worker `BL1sN615b8xezvCYEJEKhMHN4kfKLgbw8Y` and averages **92.4%** of advertised.

## How MRR behaves in practice (not in the docs)

| Finding | Effect on the code |
|---|---|
| Most KawPOW rigs are "autostart" and show 0 H/s until rented. `islive=yes` leaves 1 of 135 | No `islive` filter. Reliability comes from RPI ≥ 80 |
| Free KawPOW rigs are **1–100 GH/s**. Sub-GH rigs like the 205 MH one are rare | Plans start at about 1 GH/s. A 200 MH/s order usually can't be filled |
| Rigs embedded in `/rental` responses have no `hour` price, only `price` per unit per day and `min_rental_length` | `hourlyCost()` derives it. `min_rental_length` per currency can exceed `minhours` |
| Each rig has an `optimal_diff` window. About a third (42/135) want a pool diff of roughly 16–1000, which neither of our ports gives (10032 = 0.04–16, 10256 = 1000–9000) | Rigs are matched to a port with `portFor()`, and rigs that fit none are skipped. **Recommended:** add a pool port with varDiff of about 16–1024 to reach the rest of the market |
| The same rig costs about 25% more paid in ETH than in BTC (1 GH × 24h: $15.44 ETH vs $11.86 BTC). Some rigs only accept BTC | `MRR_CURRENCY` is configurable. **Recommended:** fund the account in BTC |
| `PUT /rental` requires a profile. Creating pools or profiles per order goes through `/account` | Every rental is created on profile 985841, then repointed with `PUT /rental/{id}/pool/0` (needs only Rentals:Write) at the customer's worker and the right port. A failed repoint keeps the paid rental, sets `poolPending`, and the poller retries |

Sample live quotes (BTC, RPI ≥ 80, 2026-10-18): 1 GH/s × 24h = **$11.86**, 5 GH/s × 24h = $71.15 (6 GH delivered), 10 GH/s × 72h = $355.72.

## Business caution: our network is tiny compared with MRR rigs

BitQube's network hashrate is about **1.0 GH/s** (explorer, 2026-10-18, difficulty 13.9). So:
- The smallest common MRR rig (1 GH/s) **doubles the whole network**. A 10 GH/s order is ten times the network.
- DGW will raise the difficulty while a rental runs and then drop it, so what any one hashrate earns swings sharply. Revenue quotes to customers must not assume today's difficulty.
- A single customer's rental can be the majority of network hashrate. It all goes to our own pool, so it isn't an attack, but it concentrates block production in one pool and makes payouts lumpy.
- The admin should set a cap on total rented hashrate.

## Rig day lifecycle

Orders are booked onto shared 24-hour rig days; the full lifecycle is in [shared-rigs.md](shared-rigs.md). Renting one:

```
rig day OPEN ──due (enough sold / waited / Rent now)──▶ RENTING
   1. GET /rig?type=<coin algo>&currency=BTC&rpi[min]=80&orderby=price  → selectRigs()
      (eligible: online, available, length fits incl. min_rental_length, RPI ≥ 80,
       for BTQ optimal_diff fits a pool.bitqube.org port; cheapest per MH first, ≤20% overfill)
   2. PUT /rental {rig, length: 24, profile: the coin's profile, currency, rate.price: listed price}
      - rate.price is a cap, so the owner can't raise the price under us
      - rig taken by someone else → re-search for the shortfall (2 retries)
   3. PUT /rental/{id}/pool/0 → the coin's pool with the house address
RENTING ──rentals recorded──▶ ACTIVE
ACTIVE ──every tick: PUT /rental/{ids}/pool/0 when the slot changes──▶ each slot's pool, house between
ACTIVE ──poller (GET /rental/{ids}, batched) sees all ended──▶ ENDED (unrun minutes rebooked)
```

## Key permissions to set on MRR

- **Balance / Withdraw: Read.** Lets the dashboard show the float and warn when it runs low. Never Write, because Write allows withdrawals.
- Rentals: Write and Rigs: Write, as now. Rigs could likely drop to Read, since we never manage our own rigs.

## Still open

- MRR rate limits are undocumented. Calls are batched and serialised, with back-off on 429/5xx.
- Ask MRR support whether reselling rentals to end customers is allowed under their terms.
- No sandbox exists. The first automated rental will be a real, small one, and needs the client's go-ahead.

## Scripts (read-only unless noted)

```
npm run mrr:smoke                                  # whoami, market, balance, sample quotes, pool test
npx tsx --env-file=.env scripts/mrr-probe.ts       # which GET endpoints this key reaches
npx tsx --env-file=.env scripts/mrr-raw.ts /rig '{"type":"kawpow","count":2}'
npx tsx --env-file=.env scripts/mrr-inspect-rental.ts <rentalId>
```

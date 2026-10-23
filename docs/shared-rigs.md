# Shared rigs and time slots

MiningRigRentals' smallest rigs are about 1 GH/s (KawPOW), much more than a beginner wants to buy. So one full-size rig is rented for 24 hours (a **rig day**) and its day is shared between customers in **slots** that run one after another.

## What a customer buys

A package is a share of one rig's day, the same for every coin:

| Package | Share | Rig time per day | On a 1 GH/s rig |
|---|---|---|---|
| Starter | 10% | 2h 24m | 100 MH/s |
| Standard | 25% | 6h | 250 MH/s |
| Plus | 50% | 12h | 500 MH/s |

100 MH/s for a day is the same work as 1 GH/s for 2h 24m, so that is what the customer gets: during their slot the whole rig mines with their address, and the pool shows about 1 GH/s for them. The order's rig minutes are `1440 × share × days`. Packages are edited in Admin → Packages; each coin's rig size is set in Admin → Coins.

Price = the live MRR cost of one rig day × share × days × markup, locked for 15 minutes (see [pricing.md](pricing.md)).

## Lifecycle

```
PENDING_PAYMENT ──all payment parts confirmed──▶ PAID
PAID ──book──▶ QUEUED          slots on OPEN rig days of the coin (new day if none has room)
rig day OPEN ──rent──▶ ACTIVE  once slots.minBookedPct of the day is sold, or the first
                               order has waited slots.maxWaitHours, or Admin → Rigs → Rent now
                               slots get times back to back from the rental start; emails sent
ACTIVE ──switch (every tick)──▶ rig points at the slot's pool/address, the house address between and after slots
order QUEUED ──first slot starts──▶ ACTIVE ──all slots done──▶ COMPLETED (≥ 90% delivered) | PARTIAL
```

- **Unsold time** mines to the coin's house address (Admin → Coins), so it isn't wasted.
- **Late or cut-short slots:** minutes that didn't run (MRR refused the switch, or the rig stopped early) are booked again on another rig day, and admins get an alert.
- **Long orders** (more than one day) are spread over several rig days, in pieces no shorter than `slots.minSlotMinutes`.
- **Spend cap:** `mrr.maxActiveCostUsd` limits what all rented rig days may cost at once. A rig day that would pass it waits.
- **Failures:** a rig day that can't be rented is retried every 10 minutes, with an alert after 3 tries. One interrupted mid-rental is marked FAILED for an admin to check MRR, then Retry.

## Coins

BTQ plus the top mining coins (BTC, LTC, DOGE, KAS, ETC, XMR, ZEC, RVN, DASH, ERG). Only BTQ is on sale at first. Before a coin can go on sale, Admin → Coins needs:

- **Pool** host, port and username template. `{address}` is replaced with the customer's payout address and `{worker}` with an id per order. "Test pool" asks MRR to connect to it; nothing is rented.
- **House address** for unsold time.
- **MRR pool profile** for the coin's algorithm. KawPOW coins fall back to `MRR_PROFILE_ID`; "Create MRR profile" makes one pointing at the house address.

Customers may use their own pool for coins that allow it (not BTQ, whose rigs are matched to pool.bitqube.org's ports by difficulty).

## BTQ payments

Admin → BTQ turns BTQ payments on or off and sets the most of a price payable in BTQ (`btq.maxSharePct`). At checkout the customer chooses how much to pay in BTQ (0% up to that, and at most `btq.maxOrderUsd`), and pays the rest by card or USDT. The order is paid once every part is confirmed. Until the card and USDT gateways are connected, an admin confirms those parts with "Mark paid" on the order. The BTQ page also shows node sync, wallet lock and keypool, the balance waiting for the sweep, and warns when the BTQ price hasn't been updated for a day.

Code: `src/lib/slots.ts` (allocation, pure), `src/lib/coins.ts` (addresses, pools), `src/worker/jobs.ts` (book, rent, switch, finish).

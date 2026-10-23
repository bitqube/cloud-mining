# Pricing and markup

The customer price is the live MRR cost multiplied by a markup.

- **Global multiplier:** setting `pricing.globalMultiplier`, default 3×. The admin panel sets it.
- **Per-customer override:** `User.priceMultiplier`, e.g. 2.5× for a long-term buyer. Clearing it puts the customer back on the global value.
- **Guard rails:** the multiplier must be between 1× and 20×. Below 1× sells at a loss, and 300 is almost certainly a typo for 3. Every change is written to `PricingChange` with the admin, the old value, the new value and a note.

## Why quotes instead of fixed-price plans

MRR is a marketplace, so the cost of the same hashrate changes from minute to minute. A customer picks a coin, a package (a share of one rig's day, see [shared-rigs.md](shared-rigs.md)) and a number of days, and gets a **Quote**:

```
quote.rigCostUsd = cheapest MRR basket for one full rig of the coin, 24h, right now (USD)
quote.costUsd    = rigCostUsd × share × days
quote.multiplier = user override ?? global
quote.priceUsd   = costUsd × multiplier, rounded up to the cent
quote.expiresAt  = now + 15 min      (the price is honoured while they pay)
```

Example: a 1 GH/s KawPOW rig for 24h costs $11.86 on MRR. Standard (25%) for 1 day costs $2.97; at 3× the customer pays **$8.90**. Unsold time on a rig day is a cost we carry (it mines to the house address), so keep the markup well above 1×.

Changing a multiplier never touches existing quotes or orders, because each one stores its own cost, multiplier and price.

## Protecting the margin at provisioning

Between the quote and the rental, rig prices can move. A rig day may cost up to the highest rig-day cost quoted to any of its customers, × 1.2 for MRR's lumpy rig sizes, **+10%** (`pricing.slippagePct`). Above that it isn't rented; it retries every 10 minutes and admins are alerted.

Code: `src/lib/pricing.ts` (pure rules, tested) and `src/lib/pricing-service.ts` (admin setters, quote creation, checkout claim).

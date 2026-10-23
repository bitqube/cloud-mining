# BitQube Cloud Mining

A platform for customers to buy hashrate contracts for BitQube (BTQ) and other top mining coins. Full-size rigs are rented from [MiningRigRentals](https://www.miningrigrentals.com) for 24 hours and shared between customers in time slots; during a slot the rig mines on the coin's pool with the customer's address as the worker. The pool pays customers directly, so the platform never holds mined coins. How the sharing works: [docs/shared-rigs.md](docs/shared-rigs.md).

Stack: Next.js (App Router, TypeScript) for the site and admin panel, PostgreSQL via Prisma, and a separate worker process for renting, pool switching and polling. The worker uses status columns as its queue (row locks, no Redis).

## Layout

- `src/lib/mrr/client.ts`: signed MRR API v2 client (HMAC-SHA1, monotonic nonce, serialised queue)
- `src/lib/mrr/api.ts`: typed wrappers for the endpoints we use
- `src/lib/mrr/selection.ts`: fills an order's hashrate with a basket of rigs
- `src/lib/providers/`: the `HashrateProvider` interface, the MRR adapter (rent, then repoint each rental at the customer's worker on the right pool port) and the router that enforces budget and shortfall rules
- `src/lib/pricing*.ts`: markup multiplier (global, per-user override), locked quotes; see `docs/pricing.md`
- `src/lib/order-service.ts`: order creation, split payments (BTQ part + the rest), admin status changes
- `src/lib/coins.ts`, `src/lib/slots.ts`: per-coin addresses and pools; splitting orders into slots on rig days
- `src/lib/settings.ts`: admin-editable settings (kill switch, spend cap, slot rules, BTQ payments)
- `src/lib/email/`: SMTP sender, email templates and the Email outbox the worker delivers from
- `src/worker/`: background jobs: book paid orders, rent rig days, switch rigs between slots, poll rentals, finish, cancel unpaid, send emails
- `src/app/`: customer pages (`/buy`, `/orders`), auth, and the admin panel (`/admin`)
- `prisma/schema.prisma`: users, coins, plans, quotes, orders, payments, rig days, slots, rentals, audit events, settings
- `docs/mrr-integration.md`: how the MRR integration works, the order lifecycle and open questions
- `docs/production-checklist.md`: credentials to replace and steps before going live
- `scripts/mrr-*.ts`: read-only live checks against MRR

## Development

```
npm install
cp .env.example .env        # fill in MRR keys
npm run db:dev              # local Postgres on :54329 (embedded, no install needed)
npm run db:migrate
npm run db:seed -- --admin you@example.com   # prints a generated password
npm run dev                 # site on :3000, admin at /admin
npm run worker              # provisioning worker (needs MRR_WORKER_API_KEY)

npm test                    # unit tests (no network)
npm run test:int            # DB tests, needs TEST_DATABASE_URL
npm run typecheck
npm run mrr:smoke           # read-only live MRR check
```

Provisioning is off by default (Admin → Dashboard). While it is off, paid orders wait and nothing is rented.

## Email

Set `SMTP_*` in `.env` (Gmail / Google Workspace needs an App Password). Every email is written to the `Email` table in the same transaction as the change it announces, and the worker sends it, retrying failures for about 4.5 hours before marking it failed. Password reset emails are sent immediately by the web app. Admin → Emails shows the SMTP status, a test-send button and the log with retry.

| When | Customer gets | Admins get |
|---|---|---|
| Signup | Welcome | |
| Forgot password | Reset link (1 hour, single use) | |
| Order placed / paid | Order received / Payment confirmed | |
| Rig day rented (or booked onto a running one) | Your slot times | Shortfall alert if under-filled |
| First slot starts | Mining now | |
| Rig day keeps failing to rent / slot ran short | | Alert |
| Worker interrupted mid-rental | (nothing until checked) | Check-MRR alert |
| Finished ≥ 90% / < 90% | Completed / Partial delivery | Partial alert |
| Cancelled, refunded, unpaid timeout | Matching notice | |

Admin alerts go to `ADMIN_ALERT_EMAIL`, or every admin account if it is empty.

## BTQ payments

With `BTQ_RPC_*` set, a BTQ price above 0 and BTQ payments switched on (Admin → BTQ), checkout lets the customer pay up to `btq.maxSharePct` of the price in BTQ and the rest by card or USDT.
- **Address:** each order gets its own deposit address from the payment node's wallet, labelled with the order id.
- **Paid:** the worker confirms the BTQ part once the full amount has `btq.confirmations` confirmations (default 6, about 6 minutes); the order is paid when every part is.
- **Admin alerts:** late, short, over-paid and reversed payments.
- **Sweep:** the coins stay in the node's encrypted wallet until an admin moves them out with `scripts/btq-sweep.sh`.

Node setup, firewalling, the sweep and the per-order cap are in [docs/btq-payments.md](docs/btq-payments.md).

## Production

See [docs/deployment.md](docs/deployment.md) for the server, Cloudflare, database and deploy script, and [docs/production-checklist.md](docs/production-checklist.md) before going live.

# Production checklist

Credentials in the development `.env` are for testing only. Replace each of these before launch.

## Replace

- [ ] **SMTP**: `SMTP_SERVER`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`. The dev values are a temporary test mailbox. Use a sender on a BitQube domain, with SPF and DKIM set up so mail doesn't land in spam.
- [ ] **MRR keys**: `MRR_API_KEY`/`MRR_API_SECRET` (web app) and `MRR_WORKER_API_KEY`/`MRR_WORKER_API_SECRET` (worker). Create fresh keys and revoke the dev ones.
  - Web key: Balance **Read**, Rentals **Write**, Rigs **Read**.
  - Worker key: Balance **None**, Rentals **Write**, Rigs **Read**.
  - Never give Balance/Withdraw **Write** to either key.
  - The keys must stay separate: MRR nonces are per key, so two processes sharing one key would reject each other's requests.
- [ ] **`APP_URL`**: the public https URL. Email links and the logo in emails use it.
- [ ] **`ADMIN_ALERT_EMAIL`**: where failure alerts go (empty = every admin account).
- [ ] **`DATABASE_URL`**: the production Postgres (DigitalOcean managed database: daily backups and point-in-time restore are built in). Use a dedicated database and user, not `doadmin`, and `?sslmode=require`.
- [ ] **`BTQ_RPC_URL`/`BTQ_RPC_USER`/`BTQ_RPC_PASSWORD`**: the payment node, over the private network. Set up the node first: [btq-payments.md](btq-payments.md).

## Before turning provisioning on

- [ ] Fund the MRR account in BTC (rentals are paid in `MRR_CURRENCY`, default BTC).
- [ ] Set the global markup (Admin → Pricing). The minimum is 1×, which sells at cost with no margin; payment fees make that a loss, so stay well above it.
- [ ] Set the spend cap and slot rules (Admin → Settings). A 1 GH/s BTQ rig is about the whole BitQube network.
- [ ] For each coin to sell (Admin → Coins): pool, house address, MRR profile, "Test pool", then put it on sale. BTQ needs its house address set.
- [ ] Send a test email from Admin → Emails.
- [ ] BTQ (Admin → BTQ): set the price, max share, confirmations, most BTQ per order and payment window, then turn BTQ payments on. Back up the encrypted node wallet offline.
- [ ] Do one small real order end to end, then turn provisioning on (Admin → Dashboard).

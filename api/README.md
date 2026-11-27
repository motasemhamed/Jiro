# Jiro — real Pi payments backend (Vercel Serverless Functions)

This folder is the missing half of the Pi Payments docs page: the backend.
The static `index.html` alone can NEVER complete a payment — approval and
completion must run on a server with the Server API Key.

## What is in here

- `api/payments/_lib.js` — shared helpers (NOT an endpoint: Vercel ignores
  files starting with `_`). Pi API calls, payment verification, the seeded
  listing price catalog (42 listings), server-side coupon table, expected-total
  math, idempotency registries, A2U serialisation.
- `api/payments/approve.js` — POST /api/payments/approve { paymentId, order? }
  Verifies the caller's Pi access token (GET /v2/me, uid parsed), fetches the
  payment from Pi and verifies payer / direction / amount / status; when the
  client sends an order payload, the Pi-recorded amount must match the
  server-recomputed expected total. Then approves with Pi (Key auth).
  Returns `{ ok, verified }` — the frontend must use the verified amount.
- `api/payments/complete.js` — POST /api/payments/complete { paymentId, txid, order? }
  Same verification as approve, plus idempotency: a replayed complete returns
  the stored verified record instead of completing twice. Returns
  `{ ok, verified }` — the escrow order is created ONLY after this returns
  200, and ONLY from `verified.amount`.
- `api/payments/incomplete.js` — POST /api/payments/incomplete
  { identifier | paymentId, txid? } — accepts both field names (the old
  frontend sent `paymentId`, the new one sends `identifier`). Verifies the
  caller owns the payment, then resumes it: completes it when a txid exists,
  approves it again when it does not. Returns `{ ok, resumed, verified }`.
- `api/payments/release.js` — POST /api/payments/release
  { orderId, kind, amount, uid, memo, origPaymentId? }
  kind: `release` | `refund` | `partial_seller` | `partial_buyer` | `a2u`.
  Performs the real App-to-User transfer with the official `pi-backend`
  package (create → submit → complete). Authorised for the admin
  (motasemhamed) or for the buyer of the verified original U2A payment;
  the amount can never exceed that original payment. One A2U at a time
  (serialised); idempotent per kind+orderId — a retry resumes the stored
  payment instead of creating a second one.
  Needs the env var `APP_WALLET_SEED` (see below). Without it the endpoint
  answers `payout_not_configured`.

The frontend (the Jiro static build) calls these endpoints with the
user's Pi access token as `Authorization: Bearer <accessToken>`.

## Env vars (Vercel project `jiro-site-eta` → Settings → Environment Variables)

- `PI_API_KEY` — Server API Key from the Pi Developer Console (Jiro app >
  Settings > API Key). Already set.
- `APP_WALLET_SEED` — the app wallet's secret seed (starts with `S`). The
  user adds this himself in Vercel. NEVER paste it in chat, in code, or in
  any file. Needed only by `/api/payments/release` (escrow payouts + the 5
  Testnet A2U wallets). Until it is set, release answers `payout_not_configured`
  and nothing else changes.

## Deploy (Vercel project `jiro-site-eta`)

The project is connected to GitHub (repo motasemhamed/Jiro): push these files
to the repo and Vercel redeploys automatically, WITH the serverless functions.
Deploy `index.html`, `validation-key.txt`, `privacy-policy.html`,
`terms-of-service.html`, `package.json` (repo root, installs `pi-backend`)
and the whole `api/` folder together. A plain static drag-and-drop deploy may
NOT deploy the `api/` functions — use the GitHub-connected deploy instead.

Test in Pi Browser (NOT in a normal browser — the /api endpoints only exist
on the Vercel deployment): open https://jirogzyr7499.pinet.com → Sign in with
Pi → buy the cheapest item → approve the payment in the Pi sheet.
Success = the order appears in Orders as "Paid — in escrow", and the Pi
console checklist item `process_transaction` flips to true.

## What this does NOT do (yet) — residual risks, recorded honestly

- No payments database: the idempotency/order registries are in-memory per
  warm Vercel instance. A cold start loses them; cross-instance replay then
  relies on Pi rejecting a duplicate `complete` (unverified). A real DB/KV is
  needed for production.
- Amount verification covers the 42 seeded listings (price catalog in
  `_lib.js`). User-created listings have no server-side price — their orders
  are still bound to the Pi-verified amount (an order can never record more
  than Pi actually moved), but the server cannot independently confirm the
  listing price. A server-side listing store is needed for full verification.
- No rate limiting (stateless functions, no external store). Vercel's
  platform limits apply.
- No Mainnet: this is Testnet (Staging). Mainnet needs the Outgoing Wallet
  approval first (blocked until 5 unique-wallet A2U payments exist).

## F1 (2026-11-27) — commission math + price signatures

- Buyer total: the display price already includes the 5% buyer commission, so
  the buyer pays display + shipping + tax only (a 100 Pi item: 105.6 Pi with
  shipping). The seller receives list price x 0.95 (95 Pi). No second 5% is
  added anywhere (frontend `breakdown()`, `expectedCartTotal`,
  `expectedSingleTotal`, `expectedOrderTotal`).
- Demo (seeded, ids 1-42) listings are NOT purchasable: any order for a
  catalog id is rejected (`invalid:true` -> `payment_amount_mismatch`).
- `POST /api/payments/sign` `{kind:"listing"|"agreed"|"bid", listingId, pricePi}`
  + Bearer token: returns an HMAC-SHA256 signature (key `PI_API_KEY`) bound to
  kind + listing id + display price + caller uid (`/v2/me`). The frontend
  signs at publish / offer-accept / bid time and stores `priceSig` +
  `priceSellerUid` on the listing/offer/bid. `approve`/`complete` verify the
  signature and reject orders whose `sellerUid` equals the payer's uid.
  A boost is `{boost:true, listingId, pricePi:2.5}` and must cost exactly 2.5 Pi.
- `approve`/`complete` now reject a payment with no order payload
  (`missing_order`): an amount that cannot be verified is never approved.
- `release` rejects a caller-supplied recipient uid that is not a full
  36-char UUID (`bad_recipient_uid`); the frontend `a2uPayAll` validates first.

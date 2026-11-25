# Jiro — real Pi payments backend (Vercel Serverless Functions)

This folder is the missing half of the Pi Payments docs page: the backend.
The static `index.html` alone can NEVER complete a payment — approval and
completion must run on a server with the Server API Key.

## What is in here

- `api/payments/approve.js` — POST /api/payments/approve { paymentId }
  Verifies the caller's Pi access token (GET /v2/me), then approves the
  payment with Pi: POST /v2/payments/{paymentId}/approve (Key auth).
- `api/payments/complete.js` — POST /api/payments/complete { paymentId, txid }
  Verifies the token, then completes the payment with Pi:
  POST /v2/payments/{paymentId}/complete { txid } (Key auth).
  The escrow order is created ONLY after this returns 200.
- `api/payments/incomplete.js` — POST /api/payments/incomplete { identifier, txid }
  Resumes a payment interrupted earlier (the onIncompletePaymentFound case):
  completes it when a txid exists, approves it again when it does not.

The frontend (the Jiro static build) calls these three endpoints with the
user's Pi access token as `Authorization: Bearer <accessToken>`.

## Deploy (Vercel project `jiro-site-eta`)

1. Generate the Server API Key — you only, in the Pi Developer Console:
   developers.minepi.com → Jiro (Staging, jiro-gzyr) → Settings → API Key →
   Generate new key. Copy it. NEVER paste it in chat, in code, or in any file.
2. Add it to Vercel — Project `jiro-site-eta` → Settings → Environment
   Variables → New: Name `PI_API_KEY`, Value = the key you just generated.
   Save. (A new key cancels the previous one — if you regenerate it later,
   update this variable too.)
3. Deploy this folder TOGETHER with `index.html` at the site root:
   `index.html`, `validation-key.txt`, `privacy-policy.html`,
   `terms-of-service.html`, and the whole `api/` folder.
   - If the project is connected to GitHub (repo motasemhamed/Jiro): push
     these files to the repo and Vercel redeploys automatically, WITH the
     serverless functions.
   - If you deploy by drag-and-drop: note that a plain static drop may NOT
     deploy the `api/` functions — use the GitHub-connected deploy instead.
4. Test in Pi Browser (NOT in a normal browser, NOT on the muse.ai link —
   the /api endpoints only exist on the Vercel deployment):
   open https://jirogzyr7499.pinet.com → Sign in with Pi → buy the cheapest
   item → approve the payment in the Pi sheet.
   Success = the order appears in Orders as "Paid — in escrow", and the Pi
   console checklist item `process_transaction` flips to true.

## What this does NOT do (yet)

- No payments database: approve/complete are stateless. If the same payment
  were completed twice, Pi itself rejects the second completion — safe, but
  there is no local record. The full version (jiro-2) keeps a payments table
  with idempotency; move to it for production.
- No Mainnet: this is Testnet (Staging). Mainnet needs the Outgoing Wallet
  approval first (blocked until 5 unique-wallet A2U payments exist).

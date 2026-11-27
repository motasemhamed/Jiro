// Jiro — App-to-User payout: escrow release / refund (Vercel Serverless Function)
// POST /api/payments/release
//   { "orderId": "...", "kind": "release"|"refund"|"partial_seller"|"partial_buyer"|"a2u",
//     "amount": <Pi>, "uid": "<recipient Pi uid>", "memo": "...",
//     "origPaymentId": "<original buyer U2A payment id>", "buyerUid": "..." }
//   + Authorization: Bearer <Pi accessToken of the admin, or of the buyer>
//
// This is the fix for review 2026-11-26 B4: until now "release" only flipped a
// local status flag and the seller was never actually paid. This endpoint
// performs the real A2U transfer with the official `pi-backend` package:
//   createPayment -> submitPayment (signs with the app-wallet seed) ->
//   completePayment. The seed comes from the Vercel env var APP_WALLET_SEED
// (the user adds it himself in Vercel; it is NEVER in code, chat or files).
//
// Authorisation:
//   - kind "a2u" (direct payout, e.g. the 5 Testnet wallets): admin only.
//   - release/refund/partial_*: the admin (Pi username motasemhamed), OR the
//     buyer of the original completed U2A payment (verified against Pi's own
//     record). The payout amount can never exceed that original payment.
//   - A seller can never release their own escrow (they are neither admin
//     nor the buyer of the original payment).
//
// Safety:
//   - One A2U payment at a time (Pi sequence-number requirement) — calls are
//     serialised with a module-level promise chain.
//   - Idempotent per kind+orderId: a retry resumes the stored paymentId
//     (submit + complete) instead of creating a second payment. If the
//     function times out mid-payout (Vercel Hobby limit), retrying with the
//     same key resumes it — never send a new key for the same payout.
//   - Residual risks (no database): the registries are in-memory per warm
//     instance; a cold start loses them, and a stuck Pi-side payment can only
//     be resumed if its metadata matches. A real DB/KV is needed for
//     production. See the fix log.

const lib = require('./_lib.js');

const KINDS = ['release', 'refund', 'partial_seller', 'partial_buyer', 'a2u'];

function getPi() {
  const apiKey = process.env.PI_API_KEY;
  const seed = process.env.APP_WALLET_SEED;
  if (!apiKey || !seed) return null;
  const mod = require('pi-backend');
  const PiNetwork = mod && mod.default ? mod.default : mod;
  return new PiNetwork(apiKey, seed);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return lib.genericError(res, 405, 'method_not_allowed');
  }
  try {
    const apiKey = process.env.PI_API_KEY;
    if (!apiKey) {
      return lib.genericError(res, 500, 'server_not_configured');
    }
    if (!process.env.APP_WALLET_SEED) {
      return lib.genericError(res, 500, 'payout_not_configured');
    }
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return lib.genericError(res, 401, 'missing_access_token');
    }
    const body = req.body || {};
    const kind = body.kind;
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    let uid = body.uid;
    const memo = typeof body.memo === 'string' ? body.memo.slice(0, 100) : '';
    let amount = Number(body.amount);
    // A refund needs no caller-supplied uid: the recipient is taken from
    // Pi's own record of the original payment (see section 2 below), so a
    // caller can never redirect a refund to another wallet.
    if (!KINDS.includes(kind) || !memo) {
      return lib.genericError(res, 400, 'bad_payout_request');
    }
    if (kind !== 'refund' && (!uid || typeof uid !== 'string')) {
      return lib.genericError(res, 400, 'bad_payout_request');
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
      return lib.genericError(res, 400, 'bad_payout_amount');
    }
    amount = lib.round2(amount);

    // 1) Who is calling?
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }
    const isAdmin = me.username && lib.ADMIN_PI_USERNAMES.includes(me.username);

    // 2) Authorisation + amount binding.
    // A refund always goes back to the original payer: the recipient is
    // taken from Pi's own record of the original payment, never from the
    // caller's request body (a caller must not be able to redirect a
    // refund to another wallet). The amount can never exceed the original.
    let orig = null;
    if (kind === 'refund') {
      const origPaymentId = body.origPaymentId;
      if (!origPaymentId || typeof origPaymentId !== 'string') {
        return lib.genericError(res, 400, 'missing_original_payment');
      }
      orig = await lib.piGetPayment(apiKey, origPaymentId);
      if (!orig || orig.direction !== 'user_to_app') {
        return lib.genericError(res, 422, 'original_payment_not_found');
      }
      if (!orig.status || !orig.status.developer_completed) {
        return lib.genericError(res, 422, 'original_payment_not_completed');
      }
      if (amount > orig.amount + 0.001) {
        return lib.genericError(res, 422, 'payout_exceeds_original');
      }
      uid = orig.user_uid;
    }
    if (kind === 'a2u') {
      if (!isAdmin) return lib.genericError(res, 403, 'admin_only');
    } else {
      if (!isAdmin) {
        if (kind !== 'refund') {
          const origPaymentId = body.origPaymentId;
          if (!origPaymentId || typeof origPaymentId !== 'string') {
            return lib.genericError(res, 403, 'not_authorised');
          }
          orig = await lib.piGetPayment(apiKey, origPaymentId);
          if (!orig || orig.user_uid !== me.uid || orig.direction !== 'user_to_app') {
            return lib.genericError(res, 403, 'not_authorised');
          }
          if (!orig.status || !orig.status.developer_completed) {
            return lib.genericError(res, 422, 'original_payment_not_completed');
          }
          if (amount > orig.amount + 0.001) {
            return lib.genericError(res, 422, 'payout_exceeds_original');
          }
        } else if (orig.user_uid !== me.uid) {
          return lib.genericError(res, 403, 'not_authorised');
        }
      }
      if (!orderId) return lib.genericError(res, 400, 'missing_order_id');
    }

    // 3) Idempotency key: one payout per kind+order (or per a2u recipient).
    const key = kind + ':' + (orderId || ('a2u:' + uid + ':' + String(amount) + ':' + memo));
    const existing = lib.releaseRegistry.get(key);
    if (existing && existing.state === 'done') {
      return res.status(200).json({ ok: true, replayed: true, payout: existing.result });
    }

    // 4) Execute, serialised (one A2U at a time).
    const payout = await lib.runA2UExclusive(async () => {
      const entry = lib.releaseRegistry.get(key);
      const pi = getPi();
      if (!pi) throw new Error('payout_not_configured');
      let paymentId;
      if (entry && entry.paymentId) {
        paymentId = entry.paymentId; // resume a created payment, never recreate
      } else {
        paymentId = await pi.createPayment({
          amount,
          memo,
          metadata: { kind, orderId: orderId || null, origPaymentId: body.origPaymentId || null },
          uid,
        });
        lib.releaseRegistry.set(key, { state: 'created', paymentId });
      }
      let txid = entry && entry.txid ? entry.txid : null;
      if (!txid) {
        txid = await pi.submitPayment(paymentId);
        lib.releaseRegistry.set(key, { state: 'submitted', paymentId, txid });
      }
      const completed = await pi.completePayment(paymentId, txid);
      const st = (completed && completed.status) || {};
      if (!st.transaction_verified || !st.developer_completed) {
        throw new Error('payout_not_verified');
      }
      const result = {
        kind,
        orderId: orderId || null,
        paymentId,
        txid,
        amount,
        uid,
        memo,
      };
      lib.releaseRegistry.set(key, { state: 'done', paymentId, txid, result });
      return result;
    });

    return res.status(200).json({ ok: true, payout });
  } catch (err) {
    // A created-but-unfinished payment stays in the registry under its key;
    // retrying with the same key resumes it. Never retry with a new key.
    // Surface the underlying reason (Pi API / pi-backend / Horizon message,
    // e.g. "You should use a private seed of your app wallet!") so the
    // admin can see WHY it failed instead of a bare code. The message never
    // contains the seed. Admin-only endpoint.
    var detail = String((err && err.message) || err || 'payout_failed').slice(0, 200);
    try { console.error('release payout error:', detail); } catch (e) {}
    return res.status(502).json({ error: 'payout_failed', detail: detail });
  }
};

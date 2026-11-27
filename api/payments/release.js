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

// Pi allows only ONE ongoing payment per app: if an earlier press created a
// payment but never completed it (e.g. submit failed), every later
// createPayment fails with ongoing_payment_found. This resumes that stuck
// payment (submit + complete) so it pays its rightful recipient, instead of
// failing forever. Throws a detailed error (with the stuck payment's
// identifier, from_address, recipient uid and the resume failure) when it
// cannot resume — e.g. "You should use a private seed of your app wallet!"
// proves the seed belongs to a different wallet than the app's.
async function resumeIncompletePayment(pi) {
  const list = await pi.getIncompleteServerPayments();
  const arr = Array.isArray(list) ? list : ((list && (list.incomplete_server_payments || list.payments)) || []);
  if (!arr.length) throw new Error('ongoing_payment_found but Pi lists no incomplete payments');
  const p = arr[0];
  let txid = null;
  try {
    txid = await pi.submitPayment(p.identifier);
  } catch (e) {
    const m = String((e && e.message) || '');
    if (m.indexOf('already has a linked txid') !== -1) {
      try { txid = JSON.parse(m).txid; } catch (_) {}
    }
    if (!txid) {
      throw new Error('cannot resume stuck payment ' + p.identifier + ' from ' + p.from_address + ' to uid ' + p.user_uid + ' amount ' + p.amount + ' created ' + p.created_at + ': ' + m);
    }
  }
  const completed = await pi.completePayment(p.identifier, txid);
  const st = (completed && completed.status) || {};
  if (!st.transaction_verified || !st.developer_completed) throw new Error('stuck payment ' + p.identifier + ' completed but not verified');
  return { payment: p, txid };
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
    // F1 (skill): a recipient uid must be a full 36-char UUID. A short or
    // mistyped uid used to reach Pi and fail there — reject it here. (A
    // refund's uid comes from Pi's own record, not the caller, so it is
    // exempt from this check.)
    if (kind !== 'refund' && !lib.isValidPiUid(uid)) {
      return lib.genericError(res, 400, 'bad_recipient_uid');
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
        // Metadata carries only defined values (no nulls) — keeps the request
        // body exactly as Pi documents it.
        var payoutMeta = { kind: kind };
        if (orderId) payoutMeta.orderId = orderId;
        if (body.origPaymentId) payoutMeta.origPaymentId = body.origPaymentId;
        try {
          paymentId = await pi.createPayment({
            amount,
            memo,
            metadata: payoutMeta,
            uid,
          });
        } catch (createErr) {
          const respData = createErr && createErr.response && createErr.response.data;
          if (!respData || respData.error !== 'ongoing_payment_found') throw createErr;
          // One stuck payment from an earlier press blocks every new create.
          // Resume it: it pays its rightful recipient. Then this row either
          // IS paid (stuck payment was for this uid) or creates a fresh
          // payment now that the block is cleared.
          const resumed = await resumeIncompletePayment(pi);
          const rMemo = resumed.payment.memo || memo;
          const rKey = 'a2u:a2u:' + resumed.payment.user_uid + ':' + String(resumed.payment.amount) + ':' + String(rMemo);
          lib.releaseRegistry.set(rKey, { state: 'done', paymentId: resumed.payment.identifier, txid: resumed.txid, result: { kind, orderId: orderId || null, paymentId: resumed.payment.identifier, txid: resumed.txid, amount: resumed.payment.amount, uid: resumed.payment.user_uid, memo: rMemo } });
          if (resumed.payment.user_uid === uid) {
            return { kind, orderId: orderId || null, paymentId: resumed.payment.identifier, txid: resumed.txid, amount: resumed.payment.amount, uid, memo: rMemo };
          }
          paymentId = await pi.createPayment({
            amount,
            memo,
            metadata: payoutMeta,
            uid,
          });
        }
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
    // Surface the underlying reason so the admin can see WHY it failed
    // instead of a bare code. Pi's API puts its real reason in the HTTP
    // response body (err.response.data) — axios's message alone is only
    // "Request failed with status code 400" and hides it. The detail never
    // contains the seed. Admin-only endpoint.
    var detail = '';
    try {
      var respData = err && err.response && err.response.data;
      if (respData) {
        detail = (typeof respData === 'string') ? respData : JSON.stringify(respData);
      }
      var respStatus = err && err.response && err.response.status;
      if (respStatus) detail = 'HTTP ' + respStatus + ': ' + detail;
    } catch (e) {}
    if (!detail) detail = String((err && err.message) || err || 'payout_failed');
    // Keep the full Pi error body: it carries the ongoing payment's
    // identifier + from_address, which the admin needs to unblock it.
    detail = detail.slice(0, 1500);
    try { console.error('release payout error:', detail); } catch (e) {}
    return res.status(502).json({ error: 'payout_failed', detail: detail });
  }
};

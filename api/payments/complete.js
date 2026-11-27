// Jiro — Pi payment completion (Vercel Serverless Function, Node.js)
// POST /api/payments/complete   { "paymentId": "...", "txid": "...", "order": {...}? }
//   + Authorization: Bearer <Pi accessToken>
//
// Fixes (review 2026-11-26):
// - B5: same verification as approve.js — the payment is fetched from Pi and
//   checked (payer, direction, amount, status, optional order-amount match)
//   before completing. The verified record is returned, and the frontend MUST
//   build the escrow order from verified.amount, never from its own total.
// - B10: idempotency — a replayed complete with the same paymentId returns
//   the stored verified record instead of completing twice. (In-memory per
//   warm instance; a real DB is still needed for production.)
//
// The escrow order is created ONLY after this endpoint returns success.
// The Server API Key lives in the Vercel env var PI_API_KEY — never in code,
// never in the frontend, never in chat.

const lib = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return lib.genericError(res, 405, 'method_not_allowed');
  }
  try {
    const apiKey = process.env.PI_API_KEY;
    if (!apiKey) {
      return lib.genericError(res, 500, 'server_not_configured');
    }
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return lib.genericError(res, 401, 'missing_access_token');
    }
    const body = req.body || {};
    const paymentId = body.paymentId;
    const txid = body.txid;
    if (!paymentId || typeof paymentId !== 'string' || !txid || typeof txid !== 'string') {
      return lib.genericError(res, 400, 'missing_payment_id_or_txid');
    }
    // F1: a completion without an order payload cannot have its amount
    // verified — see approve.js.
    if (!body.order || typeof body.order !== 'object') {
      return lib.genericError(res, 400, 'missing_order');
    }

    // B10: replay returns the stored record, no second completion.
    const stored = lib.completedPayments.get(paymentId);
    if (stored) {
      return res.status(200).json({ ok: true, replayed: true, verified: stored });
    }

    // 1) Who is calling?
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }

    // 2) Verify the payment against Pi's own record (B5).
    const v = await lib.verifyUserPayment(apiKey, me, paymentId, {
      requireApproved: true,
      requireNotCompleted: true,
      order: body.order || null,
    });
    if (!v.ok) {
      const status = v.code === 'payment_not_found' ? 404 : 422;
      return lib.genericError(res, status, v.code);
    }
    // The txid the client reports must be the one Pi recorded (when present).
    if (v.payment.transaction && v.payment.transaction.txid && v.payment.transaction.txid !== txid) {
      return lib.genericError(res, 422, 'payment_txid_mismatch');
    }

    // 3) Complete with Pi using the Server API Key.
    const completion = await fetch(
      lib.PI_API_BASE + '/payments/' + encodeURIComponent(paymentId) + '/complete',
      {
        method: 'POST',
        headers: lib.keyHeaders(apiKey, true),
        body: JSON.stringify({ txid }),
      }
    );
    if (!completion.ok) {
      return lib.genericError(res, 502, 'pi_complete_failed');
    }
    const fresh = await lib.piGetPayment(apiKey, paymentId);
    const verified = lib.verifiedView(fresh || v.payment);
    lib.completedPayments.set(paymentId, verified);
    return res.status(200).json({ ok: true, verified });
  } catch (err) {
    return lib.genericError(res, 500, 'server_error');
  }
};

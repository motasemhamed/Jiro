// Jiro — resume an incomplete Pi payment (Vercel Serverless Function, Node.js)
// POST /api/payments/incomplete   { "identifier": "...", "txid": "..." | null }
//   or { "paymentId": "...", "txid": ... }  +  Authorization: Bearer <Pi accessToken>
//
// Called by the frontend's onIncompletePaymentFound handler (Pi docs: "Send
// payment.identifier to your backend so it can complete the interrupted
// payment"). The Pi SDK calls that handler during Pi.authenticate when a
// previous payment never finished.
//
// - If the interrupted payment already has a txid (user signed, /complete
//   never ran): complete it with the Server API Key.
// - If it has no txid yet (approved, never signed): approve it again so the
//   user can sign; the normal createPayment completion flow then finishes it.
//
// Fixes (review 2026-11-26, B3 backend half): the old version read only
// `identifier`, but the frontend sent `{paymentId}` — every resume call
// failed with 400. This version accepts both names, and verifies the caller
// owns the payment before resuming it (the old version never checked).
//
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
    // B3: accept both field names (frontend fix in Group 3 sends `identifier`).
    const identifier = body.identifier || body.paymentId;
    const txid = body.txid || null;
    if (!identifier || typeof identifier !== 'string') {
      return lib.genericError(res, 400, 'missing_payment_id');
    }

    // 1) Who is calling?
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }

    // 2) The interrupted payment must belong to the caller.
    const payment = await lib.piGetPayment(apiKey, identifier);
    if (!payment) {
      return lib.genericError(res, 404, 'payment_not_found');
    }
    if (payment.user_uid !== me.uid) {
      return lib.genericError(res, 422, 'payment_user_mismatch');
    }
    if (payment.direction && payment.direction !== 'user_to_app') {
      return lib.genericError(res, 422, 'payment_wrong_direction');
    }

    // 3) Resume: complete when a txid exists, approve when it does not.
    const path = txid ? 'complete' : 'approve';
    const upstream = await fetch(
      lib.PI_API_BASE + '/payments/' + encodeURIComponent(identifier) + '/' + path,
      {
        method: 'POST',
        headers: lib.keyHeaders(apiKey, true),
        body: JSON.stringify(txid ? { txid } : {}),
      }
    );
    if (!upstream.ok) {
      return lib.genericError(res, 502, 'pi_resume_failed');
    }
    const fresh = await lib.piGetPayment(apiKey, identifier);
    const verified = fresh ? lib.verifiedView(fresh) : lib.verifiedView(payment);
    // A resumed completion is a completed payment: record it so the
    // frontend's /api/payments/mine recovery can rebuild the order (B2/B3).
    if (path === 'complete') lib.completedPayments.set(identifier, verified);
    return res.status(200).json({
      ok: true,
      resumed: path,
      verified,
    });
  } catch (err) {
    return lib.genericError(res, 500, 'server_error');
  }
};

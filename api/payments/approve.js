// Jiro — Pi payment approval (Vercel Serverless Function, Node.js)
// POST /api/payments/approve   { "paymentId": "...", "order": {...}? }
//   + Authorization: Bearer <Pi accessToken>
//
// Fixes (review 2026-11-26, B5): the old version only checked that /v2/me
// answered 200 and then approved whatever paymentId it was given — a tampered
// client could pay 0.01 Pi for a 100 Pi item. This version fetches the payment
// from Pi and verifies, before approving:
//   - the caller is the payment's payer (payment.user_uid === /v2/me uid)
//   - direction is user_to_app, amount > 0, not cancelled/approved/completed
//   - when the client sends an order payload, the Pi-recorded amount matches
//     the server-recomputed expected total (seeded catalog + server coupons)
// The verified payment summary is returned; the frontend must use it.
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
    const paymentId = body.paymentId;
    if (!paymentId || typeof paymentId !== 'string') {
      return lib.genericError(res, 400, 'missing_payment_id');
    }

    // 1) Who is calling?
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }

    // 2) Verify the payment against Pi's own record (B5).
    const v = await lib.verifyUserPayment(apiKey, me, paymentId, {
      requireNotApproved: true,
      requireNotCompleted: true,
      order: body.order || null,
    });
    if (!v.ok) {
      const status = v.code === 'payment_not_found' ? 404 : 422;
      return lib.genericError(res, status, v.code);
    }

    // 3) Approve with Pi using the Server API Key.
    const approval = await fetch(
      lib.PI_API_BASE + '/payments/' + encodeURIComponent(paymentId) + '/approve',
      { method: 'POST', headers: lib.keyHeaders(apiKey) }
    );
    if (!approval.ok) {
      return lib.genericError(res, 502, 'pi_approve_failed');
    }
    const fresh = await lib.piGetPayment(apiKey, paymentId);
    return res.status(200).json({
      ok: true,
      verified: fresh ? lib.verifiedView(fresh) : lib.verifiedView(v.payment),
    });
  } catch (err) {
    return lib.genericError(res, 500, 'server_error');
  }
};

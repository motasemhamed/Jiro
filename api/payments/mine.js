// Jiro — list my completed Pi payments (Vercel Serverless Function, Node.js)
// POST /api/payments/mine   {}  +  Authorization: Bearer <Pi accessToken>
//
// Recovery endpoint for review 2026-11-26 B2/B3: when the app was killed
// mid-payment (or the resume finished server-side), the device never created
// the escrow order. The frontend calls this after sign-in and rebuilds a
// local order for every server-completed payment that has none.
//
// Returns only the caller's own completed payments, from the server's
// in-memory record (per warm instance — a real DB is needed for production).
// No secrets are involved; the caller authenticates with their Pi token.

const lib = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return lib.genericError(res, 405, 'method_not_allowed');
  }
  try {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return lib.genericError(res, 401, 'missing_access_token');
    }
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }
    const list = [];
    lib.completedPayments.forEach(function (v) {
      if (v.user_uid === me.uid) list.push(v);
    });
    return res.status(200).json({ ok: true, payments: list });
  } catch (err) {
    return lib.genericError(res, 500, 'server_error');
  }
};

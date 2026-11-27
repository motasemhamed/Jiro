// Jiro — server-side listing price signing (Vercel Serverless Function)
// POST /api/payments/sign   { "kind": "listing"|"agreed"|"bid", "listingId": <n>, "pricePi": <display price> }
//   + Authorization: Bearer <Pi accessToken>
//
// F1 (reviewer report 2026-11-27, missed gap): the backend used to verify a
// payment against the client's own claimed price. Now the price is signed
// here, at publish / offer-accept / bid time, with HMAC-SHA256 keyed by
// PI_API_KEY, bound to the kind, the listing id, the display price and the
// caller's Pi uid (from /v2/me — the caller can only sign as themselves).
// approve.js/complete.js verify that signature before approving a payment,
// and reject any order whose sellerUid equals the payer's uid, so a buyer
// cannot re-sign a lower price as themselves.
// The signature is recorded in the in-memory listing registry (same pattern
// as the payments maps); note the registry is per warm instance AND per
// function isolate, so it is advisory — the HMAC in the order payload is
// what actually crosses from this function to the payment functions.
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
    const kind = body.kind;
    const listingId = Number(body.listingId);
    const price = lib.round2(Number(body.pricePi));
    if ((kind !== 'listing' && kind !== 'agreed' && kind !== 'bid') || !listingId || !(listingId > 0) || !(price > 0) || price > 10000) {
      return lib.genericError(res, 400, 'bad_sign_request');
    }
    const me = await lib.piGetMe(accessToken);
    if (!me) {
      return lib.genericError(res, 401, 'invalid_access_token');
    }
    const sig = lib.signListingPrice(apiKey, kind, listingId, price, me.uid);
    return res.status(200).json({ ok: true, sig, uid: me.uid, kind, listingId, price });
  } catch (err) {
    return lib.genericError(res, 500, 'server_error');
  }
};

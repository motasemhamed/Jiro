// Jiro — Pi payment completion (Vercel Serverless Function, Node.js)
// POST /api/payments/complete   { "paymentId": "...", "txid": "..." }  +  Authorization: Bearer <Pi accessToken>
//
// 1) Verifies the caller's Pi access token: GET https://api.minepi.com/v2/me
// 2) Completes the payment with the Server API Key: POST https://api.minepi.com/v2/payments/{paymentId}/complete { txid }
//
// The order is delivered ONLY after this endpoint returns success —
// the frontend creates the escrow order only when /complete answers 200.
// The Server API Key lives in the Vercel env var PI_API_KEY — never in code,
// never in the frontend, never in chat.

const PI_API_BASE = 'https://api.minepi.com/v2';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const apiKey = process.env.PI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'PI_API_KEY not configured — add it in Vercel > Settings > Environment Variables',
      });
    }
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return res.status(401).json({ error: 'Missing Pi access token' });
    }
    const { paymentId, txid } = req.body || {};
    if (!paymentId || !txid) {
      return res.status(400).json({ error: 'Missing paymentId or txid' });
    }

    // 1) Who is calling? The token must belong to a real Pi user.
    const me = await fetch(`${PI_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!me.ok) {
      return res.status(401).json({ error: 'Invalid Pi access token' });
    }

    // 2) Complete with Pi using the Server API Key.
    const completion = await fetch(
      `${PI_API_BASE}/payments/${encodeURIComponent(paymentId)}/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ txid }),
      }
    );
    const data = await completion.json().catch(() => ({}));
    return res.status(completion.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

// Jiro — resume an incomplete Pi payment (Vercel Serverless Function, Node.js)
// POST /api/payments/incomplete   { "identifier": "...", "txid": "..." | null }  +  Authorization: Bearer <Pi accessToken>
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
    const { identifier, txid } = req.body || {};
    if (!identifier) {
      return res.status(400).json({ error: 'Missing payment identifier' });
    }

    // 1) Who is calling? The token must belong to a real Pi user.
    const me = await fetch(`${PI_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!me.ok) {
      return res.status(401).json({ error: 'Invalid Pi access token' });
    }

    // 2) Resume: complete when a txid exists, approve when it does not.
    const path = txid ? 'complete' : 'approve';
    const upstream = await fetch(
      `${PI_API_BASE}/payments/${encodeURIComponent(identifier)}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(txid ? { txid } : {}),
      }
    );
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json({ resumed: path, ...data });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

// Jiro — Pi payment approval (Vercel Serverless Function, Node.js)
// POST /api/payments/approve   { "paymentId": "..." }  +  Authorization: Bearer <Pi accessToken>
//
// 1) Verifies the caller's Pi access token: GET https://api.minepi.com/v2/me
// 2) Approves the payment with the Server API Key: POST https://api.minepi.com/v2/payments/{paymentId}/approve
//
// The Server API Key lives in the Vercel env var PI_API_KEY — never in code,
// never in the frontend, never in chat. Generate it in the Pi Developer
// Console (Jiro app > Settings > API Key) and add it in Vercel:
// Project > Settings > Environment Variables > PI_API_KEY.

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
    const { paymentId } = req.body || {};
    if (!paymentId) {
      return res.status(400).json({ error: 'Missing paymentId' });
    }

    // 1) Who is calling? The token must belong to a real Pi user.
    const me = await fetch(`${PI_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!me.ok) {
      return res.status(401).json({ error: 'Invalid Pi access token' });
    }

    // 2) Approve with Pi using the Server API Key.
    const approval = await fetch(
      `${PI_API_BASE}/payments/${encodeURIComponent(paymentId)}/approve`,
      { method: 'POST', headers: { Authorization: `Key ${apiKey}` } }
    );
    const data = await approval.json().catch(() => ({}));
    return res.status(approval.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

// Jiro — shared backend helpers (Vercel Serverless Functions).
// Files in api/payments/ starting with "_" are NOT endpoints (Vercel ignores
// them as functions); they are required by approve.js / complete.js /
// incomplete.js / release.js. No secrets here: PI_API_KEY and APP_WALLET_SEED
// come from Vercel env vars only.
//
// What this fixes (review 2026-11-26):
// - B5: the backend now fetches every payment from Pi and verifies the payer,
//   direction, amount and status instead of trusting the client.
// - B10: in-memory idempotency registries (per warm instance; a real DB is
//   still needed for production — see the fix log).
// - M35: coupons are validated server-side from this table.

const PI_API_BASE = 'https://api.minepi.com/v2';
const ADMIN_PI_USERNAMES = ['motasemhamed'];
const APP_SLUG = 'jiro-gzyr';

// Seeded listing catalog: id -> [pricePi, sellerName]. Extracted from the
// frontend SEED array (42 listings). Used ONLY to verify amounts for seeded
// listings; user-created listings have no server-side price (residual risk —
// their orders are still bound to the Pi-verified amount, see complete.js).
const SEED_CATALOG = {1:[14.5,"Nile Tech Store"],2:[6.5,"Youssef K."],3:[7.8,"Style Hub"],4:[4.2,"Dina W."],5:[185,"Nile Tech Store"],6:[79,"Ahmed T."],7:[34.5,"Home Plus"],8:[23,"Mahmoud E."],9:[62,"Book Corner"],10:[42,"Mona R."],11:[18,"Book Corner"],12:[9.5,"Salma H."],13:[98.5,"Nile Phones"],14:[65,"Karim S."],15:[56,"Office Mart"],16:[28.5,"Tarek N."],17:[139,"Nile Tech Store"],18:[89,"Omar F."],19:[11.5,"Style Hub"],20:[6.8,"Nour E."],21:[21,"Sport Zone"],22:[9.5,"Peter G."],23:[6.2,"Kids Land"],24:[3.4,"Heba S."],25:[9.5,"Sara M."],26:[4.8,"Rania K."],27:[7.4,"Delta Market"],28:[3.9,"Delta Market"],29:[68,"Damietta Woodworks"],30:[49,"Wael D."],31:[169,"Home Plus"],32:[115,"Hassan A."],33:[39,"Kids Land"],34:[14.5,"Fady M."],35:[64,"Sport Zone"],36:[11.5,"Gym Outlet"],37:[7.2,"Book Corner"],38:[3.8,"Mostafa A."],39:[17.5,"Pixel Store"],40:[11,"Pixel Store"],41:[12.9,"Auto Care"],42:[8.7,"Samy R."]};
entries: 42

const COUPONS = { JIRO10: 10, WELCOME5: 5 };
const COMMISSION_RATE = 0.05; // flat 5% per side
const SHIPPING_PI = 0.6; // once per cart / per single order
const BUNDLE_RATE = 0.05; // 5% off a seller's items when buying 2+ from them

function round2(x) { return Math.round(x * 100) / 100; }
function displayPriceOf(pricePi) { return round2(pricePi * (1 + COMMISSION_RATE)); }

// Replicates the frontend cart math exactly (same rounding order).
// items: [{id, qty}]. Returns {grand, itemsTotal, buyerFee, shipping,
// bundleDisc, couponDisc} or null when any item is not in the catalog.
function expectedCartTotal(items, couponCode) {
  let itemsTotal = 0;
  const bySeller = {};
  for (const it of items) {
    const row = SEED_CATALOG[it.id];
    if (!row) return null;
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    const dp = displayPriceOf(row[0]);
    const line = round2(dp * qty);
    itemsTotal = round2(itemsTotal + line);
    const s = row[1];
    if (!bySeller[s]) bySeller[s] = { qty: 0, sum: 0 };
    bySeller[s].qty += qty;
    bySeller[s].sum = round2(bySeller[s].sum + dp * qty);
  }
  let bundleDisc = 0;
  for (const k of Object.keys(bySeller)) {
    if (bySeller[k].qty >= 2) bundleDisc = round2(bundleDisc + round2(bySeller[k].sum * BUNDLE_RATE));
  }
  const pct = couponCode && COUPONS[String(couponCode).toUpperCase()] ? COUPONS[String(couponCode).toUpperCase()] : 0;
  const couponDisc = pct ? round2((itemsTotal - bundleDisc) * pct / 100) : 0;
  const buyerFee = round2(itemsTotal * COMMISSION_RATE);
  let grand = round2(itemsTotal - bundleDisc - couponDisc + buyerFee + SHIPPING_PI);
  if (grand < 0) grand = 0;
  return { grand, itemsTotal, buyerFee, shipping: SHIPPING_PI, bundleDisc, couponDisc };
}

// Single-item / agreed-price total (same math as frontend breakdown()).
function expectedSingleTotal(pricePi) {
  const dp = displayPriceOf(pricePi);
  const buyerFee = round2(dp * COMMISSION_RATE);
  return round2(dp + buyerFee + SHIPPING_PI);
}

// Expected total for a single-item / agreed-price order payload:
// {listingId?, pricePi?, displayPrice?, shipping?, tax?, insFee?}.
// shipping must be 0 (pickup) or 0.6, tax must be 0, the insurance premium
// must be 0 or exactly 2% of the display price; a seeded listing's pricePi
// must match the catalog. Returns {expected, catalogChecked} or
// {expected:null, invalid:true} when the payload breaks the app's own rules.
function expectedOrderTotal(order) {
  if (!order || typeof order !== 'object') return null;
  if (Array.isArray(order.items) && order.items.length > 0) {
    const t = expectedCartTotal(order.items, order.coupon);
    if (!t) return null; // unknown item (user-created listing): cannot verify
    return { expected: t.grand, catalogChecked: true };
  }
  const ship = Number(order.shipping) || 0;
  const tax = Number(order.tax) || 0;
  const ins = Number(order.insFee) || 0;
  if ((ship !== 0 && ship !== SHIPPING_PI) || tax !== 0) {
    return { expected: null, invalid: true };
  }
  let dp = null;
  let catalogChecked = false;
  if (typeof order.pricePi === 'number' && order.pricePi > 0) {
    dp = displayPriceOf(order.pricePi);
    if (order.listingId && SEED_CATALOG[order.listingId]) {
      if (SEED_CATALOG[order.listingId][0] !== order.pricePi) {
        return { expected: null, invalid: true };
      }
      catalogChecked = true;
    }
  } else if (typeof order.displayPrice === 'number' && order.displayPrice > 0) {
    dp = order.displayPrice; // negotiated offer / auction price: arithmetic only
  } else if (typeof order.expectedAmount === 'number' && order.expectedAmount > 0) {
    return { expected: order.expectedAmount, catalogChecked: false };
  } else {
    return null;
  }
  if (ins !== 0 && ins !== round2(dp * 0.02)) {
    return { expected: null, invalid: true };
  }
  return { expected: round2(dp + round2(dp * COMMISSION_RATE) + ship + tax + ins), catalogChecked };
}
function keyHeaders(apiKey, json) {
  const h = { Authorization: 'Key ' + apiKey };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function piGetMe(accessToken) {
  const r = await fetch(PI_API_BASE + '/me', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.uid) return null;
  return d; // {uid, username, ...}
}

async function piGetPayment(apiKey, paymentId) {
  const r = await fetch(PI_API_BASE + '/payments/' + encodeURIComponent(paymentId), { headers: keyHeaders(apiKey) });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.identifier) return null;
  return d; // PaymentDTO
}

// Verify a user_to_app payment belongs to the caller and is payable.
// Returns {ok, payment} or {ok:false, code} where code is a short public string.
async function verifyUserPayment(apiKey, me, paymentId, opts) {
  const o = opts || {};
  const payment = await piGetPayment(apiKey, paymentId);
  if (!payment) return { ok: false, code: 'payment_not_found' };
  if (payment.user_uid !== me.uid) return { ok: false, code: 'payment_user_mismatch' };
  if (payment.direction && payment.direction !== 'user_to_app') return { ok: false, code: 'payment_wrong_direction' };
  if (typeof payment.amount !== 'number' || !(payment.amount > 0)) return { ok: false, code: 'payment_bad_amount' };
  const st = payment.status || {};
  if (st.cancelled || st.user_cancelled) return { ok: false, code: 'payment_cancelled' };
  if (o.requireApproved && !st.developer_approved) return { ok: false, code: 'payment_not_approved' };
  if (o.requireNotApproved && st.developer_approved) return { ok: false, code: 'payment_already_approved' };
  if (o.requireNotCompleted && st.developer_completed) return { ok: false, code: 'payment_already_completed' };
  // Optional order-amount check: the Pi-recorded amount must match what the
  // order should cost (see expectedOrderTotal). A payload that breaks the
  // app's own pricing rules is rejected outright.
  if (o.order) {
    const t = expectedOrderTotal(o.order);
    if (t && t.invalid) {
      return { ok: false, code: 'payment_amount_mismatch' };
    }
    if (t && t.expected !== null && Math.abs(payment.amount - t.expected) > 0.05) {
      return { ok: false, code: 'payment_amount_mismatch', expected: t.expected, catalogChecked: t.catalogChecked };
    }
  }
  return { ok: true, payment };
}

// Public (safe) view of a verified payment — this is what the frontend must
// use to build the escrow order, never its own computed total.
function verifiedView(p) {
  return {
    identifier: p.identifier,
    amount: p.amount,
    user_uid: p.user_uid,
    memo: p.memo || '',
    direction: p.direction || 'user_to_app',
    network: p.network || '',
    txid: p.transaction && p.transaction.txid ? p.transaction.txid : null,
    status: {
      developer_approved: !!(p.status && p.status.developer_approved),
      transaction_verified: !!(p.status && p.status.transaction_verified),
      developer_completed: !!(p.status && p.status.developer_completed),
      cancelled: !!((p.status && (p.status.cancelled || p.status.user_cancelled))),
    },
  };
}

// ---- Idempotency registries (in-memory, per warm instance) ----
// complete: paymentId -> verified record. release: key -> {state, paymentId, txid, result}.
const completedPayments = new Map();
const releaseRegistry = new Map();

// Serialize A2U calls: Pi requires one A2U payment at a time (sequence number).
let a2uChain = Promise.resolve();
function runA2UExclusive(fn) {
  const run = a2uChain.then(fn, fn);
  a2uChain = run.then(() => undefined, () => undefined);
  return run;
}

function genericError(res, status, code) {
  return res.status(status).json({ error: code });
}

module.exports = {
  PI_API_BASE,
  ADMIN_PI_USERNAMES,
  APP_SLUG,
  SEED_CATALOG,
  COUPONS,
  COMMISSION_RATE,
  SHIPPING_PI,
  round2,
  displayPriceOf,
  expectedCartTotal,
  expectedSingleTotal,
  expectedOrderTotal,
  keyHeaders,
  piGetMe,
  piGetPayment,
  verifyUserPayment,
  verifiedView,
  completedPayments,
  releaseRegistry,
  runA2UExclusive,
  genericError,
};

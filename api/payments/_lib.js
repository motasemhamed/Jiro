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
// F1 (reviewer report 2026-11-27):
// - #11: the buyer total no longer adds a second 5% — the display price
//   already includes it. A 100 Pi item now expects exactly 105.6 Pi
//   (105 + 0.6 shipping); the seller is paid 95 (see release.js / F2).
// - #7: demo (seeded) listings are NOT purchasable — any order for a catalog
//   id is rejected outright.
// - Missed gap: user-listing prices are verified by an HMAC signature
//   (POST /api/payments/sign, key = PI_API_KEY) bound to listing id +
//   display price + signer uid; the seller can never be the payer.
// - Boost: a flat 2.5 Pi service fee — the order must say boost:true and
//   the amount must match exactly.
// - A2U: recipient uids must be full 36-char UUIDs (see release.js).

const crypto = require('crypto');
const PI_API_BASE = 'https://api.minepi.com/v2';
const ADMIN_PI_USERNAMES = ['motasemhamed'];
const APP_SLUG = 'jiro-gzyr';

// Seeded (demo) listing catalog: id -> [pricePi, sellerName]. Extracted from
// the frontend SEED array (42 listings). Used ONLY to REJECT purchases of
// demo listings — they are not for sale (F1 #7). User-created listings are
// verified by price signature instead (see signListingPrice/verifyPriceSig).
const SEED_CATALOG = {1:[14.5,"Nile Tech Store"],2:[6.5,"Youssef K."],3:[7.8,"Style Hub"],4:[4.2,"Dina W."],5:[185,"Nile Tech Store"],6:[79,"Ahmed T."],7:[34.5,"Home Plus"],8:[23,"Mahmoud E."],9:[62,"Book Corner"],10:[42,"Mona R."],11:[18,"Book Corner"],12:[9.5,"Salma H."],13:[98.5,"Nile Phones"],14:[65,"Karim S."],15:[56,"Office Mart"],16:[28.5,"Tarek N."],17:[139,"Nile Tech Store"],18:[89,"Omar F."],19:[11.5,"Style Hub"],20:[6.8,"Nour E."],21:[21,"Sport Zone"],22:[9.5,"Peter G."],23:[6.2,"Kids Land"],24:[3.4,"Heba S."],25:[9.5,"Sara M."],26:[4.8,"Rania K."],27:[7.4,"Delta Market"],28:[3.9,"Delta Market"],29:[68,"Damietta Woodworks"],30:[49,"Wael D."],31:[169,"Home Plus"],32:[115,"Hassan A."],33:[39,"Kids Land"],34:[14.5,"Fady M."],35:[64,"Sport Zone"],36:[11.5,"Gym Outlet"],37:[7.2,"Book Corner"],38:[3.8,"Mostafa A."],39:[17.5,"Pixel Store"],40:[11,"Pixel Store"],41:[12.9,"Auto Care"],42:[8.7,"Samy R."]};
entries: 42

const COUPONS = { JIRO10: 10, WELCOME5: 5 };
const COMMISSION_RATE = 0.05; // flat 5% per side
const SHIPPING_PI = 0.6; // once per cart / per single order
const BUNDLE_RATE = 0.05; // 5% off a seller's items when buying 2+ from them
const BOOST_PRICE_PI = 2.5; // flat boost fee (F1): no commission, no shipping
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidPiUid(u) { return typeof u === 'string' && UUID_RE.test(u.trim()); }

function round2(x) { return Math.round(x * 100) / 100; }
function displayPriceOf(pricePi) { return round2(pricePi * (1 + COMMISSION_RATE)); }

// ---- F1: listing price signatures -------------------------------------
// A listing's price is signed server-side at publish time (sign.js) with
// HMAC-SHA256 keyed by PI_API_KEY, over kind + listing id + display price +
// signer uid. The signature travels in the order payload, so it crosses
// Vercel's per-function isolates — unlike an in-memory registry, which
// cannot be shared between sign.js and approve.js/complete.js (each api
// file runs in its own isolate). The registry below IS still recorded at
// sign time (same pattern as the payments maps) and is consulted as an
// extra consistency check, but the HMAC is what enforces the price.
// The anti-forgery key: the backend rejects any order whose sellerUid
// equals the payer's uid, so a buyer cannot re-sign a lower price as
// themselves — only the seller's own signature verifies for their listing.
const listingPriceRegistry = new Map(); // kind:listingId -> {kind, listingId, price, uid, sig, at}
function priceSigMessage(kind, listingId, price, uid) {
  return kind + ':' + Number(listingId) + ':' + String(round2(Number(price))) + ':' + String(uid);
}
function signListingPrice(apiKey, kind, listingId, price, uid) {
  const msg = priceSigMessage(kind, listingId, price, uid);
  const sig = crypto.createHmac('sha256', apiKey).update(msg).digest('hex');
  listingPriceRegistry.set(kind + ':' + Number(listingId), { kind, listingId: Number(listingId), price: round2(Number(price)), uid: String(uid), sig, at: Date.now() });
  return sig;
}
function verifyPriceSig(apiKey, kind, listingId, price, uid, sig) {
  if (!sig || typeof sig !== 'string' || !apiKey) return false;
  const msg = priceSigMessage(kind, listingId, price, uid);
  const expect = crypto.createHmac('sha256', apiKey).update(msg).digest('hex');
  if (sig.length !== expect.length) return false;
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expect, 'utf8')); } catch (_) { ok = false; }
  if (!ok) return false;
  // Registry consistency (advisory, per-isolate): a recorded entry with the
  // SAME signature but a different price would mean the price was swapped
  // after signing — reject. A stale entry (different signature) is ignored.
  const entry = listingPriceRegistry.get(kind + ':' + Number(listingId));
  if (entry && entry.sig === sig && entry.price !== round2(Number(price))) return false;
  return true;
}

// Replicates the frontend cart math exactly (same rounding order).
// items: [{id, qty, displayPrice, priceSig, sellerUid, sellerName?}].
// Seeded (demo) listings are NOT purchasable: any catalog id rejects the
// whole cart. A user listing must carry the server price signature for its
// display price, signed by a uid other than the payer's. The bundle
// discount groups by seller NAME, exactly like the frontend. Returns
// {grand, itemsTotal, buyerFee, shipping, bundleDisc, couponDisc},
// {invalid:true} when an item breaks the rules, or null when there is
// nothing to verify.
function expectedCartTotal(items, couponCode, payerUid, apiKey) {
  let itemsTotal = 0;
  const bySeller = {};
  for (const it of items) {
    const id = Number(it.id);
    if (!Number.isFinite(id) || id <= 0) return { invalid: true };
    if (SEED_CATALOG[id]) return { invalid: true }; // demo listing: not for sale
    const dp = round2(Number(it.displayPrice));
    if (!(dp > 0) || !it.priceSig || !it.sellerUid) return { invalid: true };
    if (!verifyPriceSig(apiKey, 'listing', id, dp, it.sellerUid, it.priceSig)) return { invalid: true };
    if (payerUid && String(it.sellerUid) === String(payerUid)) return { invalid: true };
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    const line = round2(dp * qty);
    itemsTotal = round2(itemsTotal + line);
    const s = it.sellerName ? String(it.sellerName) : String(it.sellerUid);
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
  const buyerFee = 0; // F1 (#11): the 5% buyer commission is inside the display prices
  let grand = round2(itemsTotal - bundleDisc - couponDisc + SHIPPING_PI);
  if (grand < 0) grand = 0;
  return { grand, itemsTotal, buyerFee, shipping: SHIPPING_PI, bundleDisc, couponDisc };
}

// Single-item / agreed-price total (same math as frontend breakdown()).
function expectedSingleTotal(pricePi) {
  const dp = displayPriceOf(pricePi);
  return round2(dp + SHIPPING_PI); // F1 (#11): no second 5% — it is inside dp
}

// Expected total for an order payload. The payload must now PROVE its price:
//  - {boost:true, listingId, ...} — a flat 2.5 Pi boost fee, no commission.
//  - {items:[...]} — a cart; every item is signature-verified (see above).
//  - {listingId, displayPrice, priceSig, sellerUid, shipping?, tax?, insFee?}
//    — a single listing or an agreed price (priceSigKind "agreed"); an
//    auction win also carries bidSig/bidderUid/listingDisplayPrice.
// shipping must be 0 (pickup) or 0.6, tax must be 0, the insurance premium
// must be 0 or exactly 2% of the display price. A seeded (demo) listing is
// rejected outright. Returns {expected, catalogChecked} or
// {expected:null, invalid:true} when the payload breaks the app's rules or
// cannot be verified. Returns null only when there is no order at all.
// (The old pricePi-only and expectedAmount branches trusted the client's own
// claim — both are deleted: an unverifiable price is rejected, never trusted.)
function expectedOrderTotal(order, payerUid, apiKey) {
  if (!order || typeof order !== 'object') return null;
  if (order.boost === true) {
    if (!order.listingId || !(Number(order.listingId) > 0)) return { expected: null, invalid: true };
    return { expected: BOOST_PRICE_PI, catalogChecked: false };
  }
  if (Array.isArray(order.items) && order.items.length > 0) {
    const t = expectedCartTotal(order.items, order.coupon, payerUid, apiKey);
    if (!t) return null;
    if (t.invalid) return { expected: null, invalid: true };
    return { expected: t.grand, catalogChecked: true };
  }
  const ship = Number(order.shipping) || 0;
  const tax = Number(order.tax) || 0;
  const ins = Number(order.insFee) || 0;
  if ((ship !== 0 && ship !== SHIPPING_PI) || tax !== 0) {
    return { expected: null, invalid: true };
  }
  const listingId = Number(order.listingId);
  if (!listingId || !(listingId > 0)) return { expected: null, invalid: true };
  if (SEED_CATALOG[listingId]) return { expected: null, invalid: true }; // demo listing: not for sale
  const dp = round2(Number(order.displayPrice));
  if (!(dp > 0)) return { expected: null, invalid: true };
  if (!order.priceSig || !order.sellerUid) return { expected: null, invalid: true };
  // For an auction win the listing signature binds the LISTING's display
  // price (listingDisplayPrice), not the winning bid (dp).
  const sigPrice = order.bidSig ? round2(Number(order.listingDisplayPrice)) : dp;
  if (!(sigPrice > 0)) return { expected: null, invalid: true };
  const kind = order.priceSigKind === 'agreed' ? 'agreed' : 'listing';
  if (!verifyPriceSig(apiKey, kind, listingId, sigPrice, order.sellerUid, order.priceSig)) {
    return { expected: null, invalid: true };
  }
  if (payerUid && String(order.sellerUid) === String(payerUid)) {
    return { expected: null, invalid: true }; // the seller can never pay themselves
  }
  if (order.bidSig) {
    // Auction win: the winning bid must be signed by the bidder (who must be
    // the payer) and must be at least the listing's signed display price.
    if (!order.bidderUid || !order.listingDisplayPrice) return { expected: null, invalid: true };
    if (!verifyPriceSig(apiKey, 'bid', listingId, dp, order.bidderUid, order.bidSig)) {
      return { expected: null, invalid: true };
    }
    if (payerUid && String(order.bidderUid) !== String(payerUid)) {
      return { expected: null, invalid: true };
    }
    if (dp < sigPrice) {
      return { expected: null, invalid: true };
    }
  }
  if (ins !== 0 && ins !== round2(dp * 0.02)) {
    return { expected: null, invalid: true };
  }
  return { expected: round2(dp + ship + tax + ins), catalogChecked: true };
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
    const t = expectedOrderTotal(o.order, me.uid, apiKey);
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
  BOOST_PRICE_PI,
  isValidPiUid,
  listingPriceRegistry,
  priceSigMessage,
  signListingPrice,
  verifyPriceSig,
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

/* ─────────────────────────────────────────────────────────────
   Kanka — shared server helpers
   No npm dependencies. Node 18+ (global fetch, node:crypto).
   ───────────────────────────────────────────────────────────── */

import crypto from "node:crypto";

/* ─── Env ─────────────────────────────────────────────────── */
export const ENV = {
  SUPABASE_URL:            process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY:    process.env.SUPABASE_SERVICE_KEY,
  RAZORPAY_KEY_ID:         process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET:     process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
};

export function requireEnv(...keys) {
  const missing = keys.filter(k => !ENV[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

/* ─── Pricing rules (SERVER IS THE ONLY AUTHORITY) ────────── */
export const PRICING = {
  GST_RATE: 0.12,
  FREE_SHIPPING_THRESHOLD: 5000,   // rupees
  SHIPPING: {
    standard: { label: "Standard Shipping", price: 149, freeOver: 5000 },
    express:  { label: "Express Shipping",  price: 299, freeOver: null },
    next:     { label: "Next Day Delivery", price: 499, freeOver: null },
  },
  MAX_QTY_PER_LINE: 10,
};

/* Money is handled in PAISE (integers) everywhere past this point. */
export const toPaise   = rupees => Math.round(Number(rupees) * 100);
export const fromPaise = paise  => Number(paise) / 100;

/* ─── Supabase REST (service_role — full DB power) ────────── */
async function sb(path, { method = "GET", body, prefer } = {}) {
  requireEnv("SUPABASE_URL", "SUPABASE_SERVICE_KEY");
  const headers = {
    apikey:        ENV.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${ENV.SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (table, query) => sb(`/rest/v1/${table}?${query}`),
  insert: (table, rows)  => sb(`/rest/v1/${table}`, {
    method: "POST", body: rows, prefer: "return=representation",
  }),
  update: (table, query, patch) => sb(`/rest/v1/${table}?${query}`, {
    method: "PATCH", body: patch, prefer: "return=representation",
  }),
  /* Postgres function call — used for atomic, idempotent fulfilment */
  rpc: (fn, args) => sb(`/rest/v1/rpc/${fn}`, { method: "POST", body: args }),
};

/* ─── Razorpay REST ───────────────────────────────────────── */
function rzpAuth() {
  requireEnv("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET");
  return "Basic " + Buffer
    .from(`${ENV.RAZORPAY_KEY_ID}:${ENV.RAZORPAY_KEY_SECRET}`)
    .toString("base64");
}

export const razorpay = {
  async createOrder({ amountPaise, receipt, notes }) {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: rzpAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: "INR",
        receipt,
        notes,
        payment_capture: 1,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Razorpay order failed: ${JSON.stringify(json)}`);
    return json;
  },

  async fetchPayment(paymentId) {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: rzpAuth() },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Razorpay payment fetch failed: ${JSON.stringify(json)}`);
    return json;
  },
};

/* ─── Caller identity ──────────────────────────────────────── */
/* The browser can put anything it wants in a request body, including
   someone else's customer_id — a body value is a claim, not proof.
   The only thing that counts as proof of who's calling is a Supabase
   access token, verified here against Supabase itself. Callers must
   derive customer_id from this, never from the body. Returns null for
   guests (no/invalid token) — guest checkout stays supported. */
export async function getAuthedUserId(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  requireEnv("SUPABASE_URL", "SUPABASE_SERVICE_KEY");
  try {
    const res = await fetch(`${ENV.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id || null;
  } catch (err) {
    console.error("[kanka] auth token verification failed", err?.message || err);
    return null;
  }
}

/* ─── Signature verification ──────────────────────────────── */

/* Timing-safe compare — never use === on secrets. */
export function safeEqual(a = "", b = "") {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* Checkout callback:  HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET) */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  requireEnv("RAZORPAY_KEY_SECRET");
  const expected = crypto
    .createHmac("sha256", ENV.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqual(expected, signature);
}

/* Webhook:  HMAC_SHA256(raw_request_body, WEBHOOK_SECRET) */
export function verifyWebhookSignature({ rawBody, signature }) {
  requireEnv("RAZORPAY_WEBHOOK_SECRET");
  const expected = crypto
    .createHmac("sha256", ENV.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, signature);
}

/* ─── Razorpay id shape checks ────────────────────────────── */
/* Razorpay's own id formats. Anything claiming to be one of these ids
   gets checked against this BEFORE it's allowed anywhere near a
   PostgREST filter string — those are built by raw interpolation
   (see eqFilter below), so an unvalidated id is a filter-injection
   surface, not just a "malformed input" problem. */
const RZP_ORDER_ID_RE   = /^order_[A-Za-z0-9]{1,64}$/;
const RZP_PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{1,64}$/;

export function isValidRazorpayOrderId(id) {
  return typeof id === "string" && RZP_ORDER_ID_RE.test(id);
}
export function isValidRazorpayPaymentId(id) {
  return typeof id === "string" && RZP_PAYMENT_ID_RE.test(id);
}

/* Build a single-column PostgREST equality filter. encodeURIComponent
   is defense in depth on top of the id-shape checks above — belt and
   suspenders, since this helper has no way to know whether its caller
   already validated the value. */
export function eqFilter(column, value) {
  return `${column}=eq.${encodeURIComponent(value)}`;
}

/* ─── Misc ────────────────────────────────────────────────── */
export function orderNumber() {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  return `KNK-${rand}`;
}

export function idempotencyKey() {
  return crypto.randomUUID();
}

export function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/* Generic guard used at the top of every handler. */
export function methodGuard(req, res, allowed = "POST") {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", allowed);
    res.status(204).end();
    return false;
  }
  if (req.method !== allowed) {
    json(res, 405, { error: "Method not allowed" });
    return false;
  }
  return true;
}

/* Never leak internals to the browser. Log full, return generic. */
export function fail(res, err, publicMessage = "Something went wrong. Please try again.") {
  console.error("[kanka]", err?.stack || err);
  json(res, 500, { error: publicMessage });
}

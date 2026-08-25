/* ─────────────────────────────────────────────────────────────
   POST /api/verify-payment

   Called by the browser right after Razorpay Checkout succeeds.
   This is the FAST path — it exists so the customer sees their
   confirmation immediately. The webhook is the authoritative one.

   A forged signature gets nothing: no order is marked paid, no
   stock moves, no discount is consumed.
   ───────────────────────────────────────────────────────────── */

import {
  db, razorpay, requireEnv,
  json, methodGuard, fail, verifyCheckoutSignature,
  isValidRazorpayOrderId, isValidRazorpayPaymentId, eqFilter,
  rateLimit, tooManyRequests,
} from "./_lib/kanka.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  /* Forging a signature is computationally infeasible, but there's no
     reason to let anyone try at speed — and each failed attempt writes
     a signature_failed flag to the order row. */
  const limit = rateLimit(req, { key: "verify", max: 20, windowMs: 60_000 });
  if (!limit.ok) {
    return tooManyRequests(res, limit.retryAfter);
  }

  try {
    requireEnv("RAZORPAY_KEY_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_KEY");

    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const orderId   = String(body.razorpay_order_id   || "");
    const paymentId = String(body.razorpay_payment_id || "");
    const signature = String(body.razorpay_signature  || "");

    if (!orderId || !paymentId || !signature) {
      return json(res, 400, { error: "Incomplete payment response.", verified: false });
    }

    /* Reject anything that isn't shaped like a real Razorpay id BEFORE
       it goes anywhere near a database query — these ids get spliced
       into PostgREST filter strings below, and at this point (pre
       signature check) they're still fully attacker-controlled. */
    if (!isValidRazorpayOrderId(orderId) || !isValidRazorpayPaymentId(paymentId)) {
      return json(res, 400, { error: "Malformed payment response.", verified: false });
    }

    /* 1. The only thing that matters: does the signature check out?
          HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET) */
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      console.warn("[kanka] signature mismatch", { orderId, paymentId });
      /* Flag it, but do NOT fulfil anything. */
      await db.update("orders", eqFilter("razorpay_order_id", orderId), {
        payment_status: "signature_failed",
      }).catch(() => {});
      return json(res, 400, { error: "Payment could not be verified.", verified: false });
    }

    /* 2. Signature is good. Confirm with Razorpay that the payment is
          actually captured and the amount matches what we asked for.
          (Signature proves authenticity, not that money moved.) */
    const [order] = await db.select(
      "orders",
      `${eqFilter("razorpay_order_id", orderId)}&select=id,order_number,status,payment_status,total_amount&limit=1`,
    );
    if (!order) {
      return json(res, 404, { error: "Order not found.", verified: false });
    }

    const payment = await razorpay.fetchPayment(paymentId);
    const expectedPaise = Math.round(Number(order.total_amount) * 100);

    if (payment.order_id !== orderId) {
      return json(res, 400, { error: "Payment does not match this order.", verified: false });
    }
    if (Number(payment.amount) !== expectedPaise) {
      console.error("[kanka] amount mismatch", { orderId, paid: payment.amount, expectedPaise });
      return json(res, 400, { error: "Payment amount mismatch.", verified: false });
    }
    if (!["captured", "authorized"].includes(payment.status)) {
      return json(res, 200, {
        verified: false,
        pending:  true,
        order_number: order.order_number,
        message: "Payment is still processing. We'll email you once it's confirmed.",
      });
    }

    /* 3. Fulfil — atomic and idempotent inside Postgres:
          marks paid, decrements variant stock, increments discount usage.
          Running it twice changes nothing the second time. */
    const result = await db.rpc("fulfill_order", {
      p_order_id:   order.id,
      p_payment_id: paymentId,
      p_source:     "checkout",
    });

    if (result?.stock_issue || result?.discount_issue) {
      console.error("[kanka] fulfilled with oversell/over-redemption — needs manual review", {
        orderId: order.id, orderNumber: order.order_number,
        stock_issue: result.stock_issue, discount_issue: result.discount_issue,
      });
    }

    return json(res, 200, {
      verified:     true,
      order_number: order.order_number,
      already_processed: result?.already_processed ?? false,
    });

  } catch (err) {
    return fail(res, err, "We couldn't confirm your payment yet. If money left your account, it is safe — we'll email you shortly.");
  }
}

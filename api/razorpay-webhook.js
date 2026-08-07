/* ─────────────────────────────────────────────────────────────
   POST /api/razorpay-webhook

   Razorpay → our server, directly. Independent of the browser:
   if the customer closes the tab mid-payment, this still fires
   and the order still gets fulfilled.

   THIS IS THE SOURCE OF TRUTH. The checkout callback is UX only.

   Razorpay retries failed webhooks, so every path here must be
   safe to run repeatedly — hence the idempotent RPC.
   ───────────────────────────────────────────────────────────── */

import {
  db, requireEnv, json, fail, verifyWebhookSignature,
  isValidRazorpayOrderId, eqFilter,
} from "./_lib/kanka.js";

/* Signature is computed over the EXACT bytes Razorpay sent.
   Any JSON re-serialisation breaks it — so the body parser is off. */
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  /* If the platform buffered it for us anyway, use those exact bytes. */
  if (Buffer.isBuffer(req.body))          return Promise.resolve(req.body.toString("utf8"));
  if (typeof req.body === "string")       return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  c => chunks.push(Buffer.from(c)));
    req.on("end",   () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    requireEnv("RAZORPAY_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_KEY");

    const rawBody   = await readRawBody(req);
    const signature = req.headers["x-razorpay-signature"];

    if (!signature || !verifyWebhookSignature({ rawBody, signature })) {
      console.warn("[kanka] webhook signature rejected");
      /* 400, not 500 — tells Razorpay not to bother retrying a forgery. */
      return json(res, 400, { error: "Invalid signature" });
    }

    const event   = JSON.parse(rawBody);
    const type    = event.event;
    const payment = event?.payload?.payment?.entity;
    const rzpOrder = event?.payload?.order?.entity;

    const razorpayOrderId = payment?.order_id || rzpOrder?.id;
    if (!razorpayOrderId) {
      return json(res, 200, { ok: true, ignored: `no order id on ${type}` });
    }
    /* Signature is already verified above, so this id came from
       Razorpay — but validate its shape anyway before it goes into a
       filter string, rather than trusting the payload structure. */
    if (!isValidRazorpayOrderId(razorpayOrderId)) {
      console.warn("[kanka] webhook order id doesn't look like a Razorpay id", razorpayOrderId);
      return json(res, 200, { ok: true, ignored: "malformed order id" });
    }

    const [order] = await db.select(
      "orders",
      `${eqFilter("razorpay_order_id", razorpayOrderId)}&select=id,order_number,status,payment_status,total_amount&limit=1`,
    );
    if (!order) {
      /* 200 so Razorpay stops retrying — nothing here to fix. */
      console.warn("[kanka] webhook for unknown order", razorpayOrderId);
      return json(res, 200, { ok: true, ignored: "unknown order" });
    }

    switch (type) {
      case "payment.captured":
      case "order.paid": {
        const expectedPaise = Math.round(Number(order.total_amount) * 100);
        const paidPaise     = Number(payment?.amount ?? rzpOrder?.amount_paid ?? 0);

        if (paidPaise !== expectedPaise) {
          console.error("[kanka] webhook amount mismatch", {
            razorpayOrderId, paidPaise, expectedPaise,
          });
          await db.update("orders", `id=eq.${order.id}`, {
            payment_status: "amount_mismatch",
          });
          return json(res, 200, { ok: true, flagged: "amount_mismatch" });
        }

        /* Idempotent: second delivery of the same event is a no-op. */
        const result = await db.rpc("fulfill_order", {
          p_order_id:   order.id,
          p_payment_id: payment?.id ?? null,
          p_source:     "webhook",
        });

        if (result?.stock_issue || result?.discount_issue) {
          console.error("[kanka] fulfilled with oversell/over-redemption — needs manual review", {
            orderId: order.id, orderNumber: order.order_number,
            stock_issue: result.stock_issue, discount_issue: result.discount_issue,
          });
        }

        return json(res, 200, {
          ok: true,
          fulfilled: true,
          already_processed: result?.already_processed ?? false,
        });
      }

      case "payment.failed": {
        /* Only downgrade an order that hasn't already been paid —
           a late failure event must never undo a successful capture. */
        if (order.payment_status !== "paid") {
          await db.update("orders", `id=eq.${order.id}`, {
            status:             "failed",
            payment_status:     "failed",
            razorpay_payment_id: payment?.id ?? null,
            failure_reason:     payment?.error_description ?? null,
          });
        }
        return json(res, 200, { ok: true, recorded: "failed" });
      }

      case "refund.created":
      case "refund.processed": {
        await db.update("orders", `id=eq.${order.id}`, {
          payment_status: "refunded",
          status:         "refunded",
        });
        return json(res, 200, { ok: true, recorded: "refunded" });
      }

      default:
        return json(res, 200, { ok: true, ignored: type });
    }

  } catch (err) {
    /* 500 makes Razorpay retry — correct for a transient DB blip. */
    return fail(res, err, "Webhook processing failed");
  }
}

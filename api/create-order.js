/* ─────────────────────────────────────────────────────────────
   POST /api/create-order

   Browser sends:  cart lines (id/colour/size/qty), shipping
                   method, promo code, delivery address.
   Server does:    real prices from DB → stock check → discount
                   check → totals → Razorpay order → pending row.
   Browser gets:   razorpay order_id + amount. Nothing else.
   ───────────────────────────────────────────────────────────── */

import {
  db, razorpay, ENV, requireEnv,
  json, methodGuard, fail, orderNumber, idempotencyKey, fromPaise,
  getAuthedUserId,
} from "./_lib/kanka.js";
import { buildQuote, QuoteError } from "./_lib/quote.js";

function sanitiseCustomer(c = {}) {
  const s = (v, max = 120) => String(v ?? "").trim().slice(0, max);

  const email = s(c.email, 160).toLowerCase();
  const phone = s(c.phone, 20).replace(/[^\d+]/g, "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new QuoteError("Please enter a valid email address.", "BAD_EMAIL");
  }
  if (phone.replace(/\D/g, "").length < 10) {
    throw new QuoteError("Please enter a valid phone number.", "BAD_PHONE");
  }

  const first = s(c.firstName ?? c.first_name, 60);
  const last  = s(c.lastName  ?? c.last_name, 60);
  const line1 = s(c.address, 200);
  const city  = s(c.city, 80);
  const zip   = s(c.zip, 12).replace(/\s/g, "");

  if (!first || !line1 || !city || !zip) {
    throw new QuoteError("Please complete your delivery address.", "BAD_ADDRESS");
  }

  return {
    email, phone,
    full_name:  `${first} ${last}`.trim(),
    first_name: first,
    last_name:  last,
    line1,
    line2:   s(c.apt, 200),
    city,
    state:   s(c.state, 80),
    zip,
    country: s(c.country, 60) || "India",
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  try {
    requireEnv("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_KEY");

    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const { items, discount_code, shipping_method, customer } = body;

    /* customer_id is NEVER taken from the body — the browser could
       put anyone's UUID there. It's derived only from a verified
       Supabase access token, so an order can only ever be attributed
       to whoever is actually signed in (or nobody, for guest
       checkout). */
    const customerId = await getAuthedUserId(req);

    /* 1. Everything money-related is recomputed here, from the DB. */
    const quote   = await buildQuote({
      items,
      discountCode:   discount_code,
      shippingMethod: shipping_method,
    });
    const address = sanitiseCustomer(customer);
    const orderNo = orderNumber();
    const idemKey = idempotencyKey();

    /* 2. Razorpay order first — if this fails, no orphan row is left behind. */
    const rzpOrder = await razorpay.createOrder({
      amountPaise: quote.totalPaise,
      receipt:     orderNo,
      notes: {
        order_number:    orderNo,
        customer_email:  address.email,
        customer_phone:  address.phone,
        idempotency_key: idemKey,
      },
    });

    /* 3. Store the pending order. Rupees in our table, paise on Razorpay's side. */
    const [order] = await db.insert("orders", [{
      order_number:      orderNo,
      /* Legacy short-name columns. This table predates the migration and
         still has NOT NULL constraints on `email` and `total`, so both
         the old and new names are written on every insert. Dropping the
         constraints (see the migration) removes the need for this, but
         writing them keeps old admin queries that read these columns
         working. */
      email:             address.email,
      total:             fromPaise(quote.totalPaise),
      customer_id:       customerId,
      status:            "pending",
      payment_status:    "pending",
      payment_provider:  "razorpay",
      razorpay_order_id: rzpOrder.id,
      idempotency_key:   idemKey,
      subtotal:          fromPaise(quote.subtotalPaise),
      discount_amount:   fromPaise(quote.discountPaise),
      discount_code:     quote.discountCode,
      shipping_amount:   fromPaise(quote.shippingPaise),
      shipping_method:   quote.shippingMethod,
      tax_amount:        fromPaise(quote.taxPaise),
      total_amount:      fromPaise(quote.totalPaise),
      currency:          "INR",
      customer_email:    address.email,
      customer_phone:    address.phone,
      customer_name:     address.full_name,
      shipping_address:  address,
    }]);

    await db.insert("order_items", quote.lines.map(l => ({
      order_id:     order.id,
      product_id:   l.product_id,
      variant_id:   l.variant_id,
      product_name: l.name,
      sku:          l.sku,
      color:        l.color,
      size:         l.size,
      quantity:     l.quantity,
      unit_price:   fromPaise(l.unitPricePaise),
      line_total:   fromPaise(l.linePaise),
      /* Legacy NOT NULL column on order_items — same split as above. */
      total_price:  fromPaise(l.linePaise),
    })));

    /* 4. Only non-secret data crosses back. KEY_ID is publishable;
          KEY_SECRET never leaves this file's process. */
    return json(res, 200, {
      key_id:            ENV.RAZORPAY_KEY_ID,
      razorpay_order_id: rzpOrder.id,
      amount:            quote.totalPaise,
      currency:          "INR",
      order_number:      orderNo,
      prefill: {
        name:    address.full_name,
        email:   address.email,
        contact: address.phone,
      },
      breakdown: {
        subtotal:       fromPaise(quote.subtotalPaise),
        discount:       fromPaise(quote.discountPaise),
        discount_code:  quote.discountCode,
        shipping:       fromPaise(quote.shippingPaise),
        shipping_label: quote.shippingLabel,
        tax:            fromPaise(quote.taxPaise),
        total:          fromPaise(quote.totalPaise),
      },
    });

  } catch (err) {
    if (err instanceof QuoteError || err?.isPublic) {
      return json(res, 400, { error: err.message, code: err.code });
    }
    return fail(res, err, "We couldn't start your payment. Please try again.");
  }
}

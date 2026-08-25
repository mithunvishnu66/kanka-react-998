/* ─────────────────────────────────────────────────────────────
   POST /api/validate-discount

   Powers the promo-code box. Purely for UX feedback — the real
   enforcement happens again inside /api/create-order, because
   anything the browser is told can be edited by the browser.
   ───────────────────────────────────────────────────────────── */

import { json, methodGuard, fail, toPaise, fromPaise, rateLimit, tooManyRequests } from "./_lib/kanka.js";
import { validateDiscount, QuoteError } from "./_lib/quote.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  /* This endpoint tells the caller whether a code is real, which makes it
     the natural target for guessing them. 15 tries a minute is far more
     than a shopper needs and far less than a guessing attack wants. */
  const limit = rateLimit(req, { key: "discount", max: 15, windowMs: 60_000 });
  if (!limit.ok) {
    return tooManyRequests(res, limit.retryAfter, "Too many code attempts. Please wait a minute.");
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const subtotal = Number(body.subtotal);
    if (!Number.isFinite(subtotal) || subtotal < 0) {
      return json(res, 400, { valid: false, error: "Invalid cart total." });
    }

    const result = await validateDiscount(body.code, toPaise(subtotal));

    if (!result.code) {
      return json(res, 400, { valid: false, error: "Please enter a promo code." });
    }

    return json(res, 200, {
      valid:    true,
      code:     result.code,
      discount: fromPaise(result.discountPaise),
      label:    result.type?.startsWith("percent")
        ? `${result.value}% off`
        : `₹${Number(result.value).toLocaleString("en-IN")} off`,
    });

  } catch (err) {
    if (err instanceof QuoteError || err?.isPublic) {
      return json(res, 400, { valid: false, error: err.message, code: err.code });
    }
    return fail(res, err, "Couldn't check that code right now.");
  }
}

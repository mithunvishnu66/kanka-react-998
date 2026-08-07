/* ─────────────────────────────────────────────────────────────
   Kanka — server-authoritative quote builder

   The browser sends ONLY: product_id, color, size, quantity.
   Everything with a rupee sign attached is computed here, from
   the database. Nothing the browser claims about price, discount
   or shipping is ever trusted.
   ───────────────────────────────────────────────────────────── */

import { db, PRICING, toPaise } from "./kanka.js";

export class QuoteError extends Error {
  constructor(message, code = "INVALID_CART") {
    super(message);
    this.code = code;
    this.isPublic = true;   // safe to show the customer
  }
}

/* ─── Cart shape validation ───────────────────────────────── */
function sanitiseItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new QuoteError("Your bag is empty.", "EMPTY_CART");
  }
  if (raw.length > 50) {
    throw new QuoteError("Too many items in one order.", "CART_TOO_LARGE");
  }

  return raw.map((it, i) => {
    const product_id = String(it?.product_id || "").trim();
    const color      = String(it?.color || "").trim();
    const size       = String(it?.size  || "").trim();
    const quantity   = Number.parseInt(it?.quantity, 10);

    if (!/^[0-9a-f-]{36}$/i.test(product_id)) {
      throw new QuoteError(`Item ${i + 1} is invalid. Please rebuild your bag.`);
    }
    if (!color || !size) {
      throw new QuoteError(`Item ${i + 1} is missing a colour or size.`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > PRICING.MAX_QTY_PER_LINE) {
      throw new QuoteError(`Quantity for item ${i + 1} must be between 1 and ${PRICING.MAX_QTY_PER_LINE}.`);
    }
    return { product_id, color, size, quantity };
  });
}

/* Merge duplicate lines (same product+colour+size) so stock maths is correct. */
function collapse(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${it.product_id}|${it.color}|${it.size}`;
    const existing = map.get(key);
    if (existing) {
      existing.quantity = Math.min(existing.quantity + it.quantity, PRICING.MAX_QTY_PER_LINE);
    } else {
      map.set(key, { ...it });
    }
  }
  return [...map.values()];
}

/* ─── Discount validation (against discount_codes table) ──── */
export async function validateDiscount(rawCode, subtotalPaise) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { code: null, discountPaise: 0, row: null };

  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
    throw new QuoteError("That promo code isn't valid.", "BAD_DISCOUNT");
  }

  const rows = await db.select(
    "discount_codes",
    `code=eq.${encodeURIComponent(code)}&select=*&limit=1`,
  );
  const row = rows?.[0];
  if (!row) throw new QuoteError("That promo code isn't valid.", "BAD_DISCOUNT");

  /* Column names are read defensively — this table may use any of
     several naming conventions, so we accept all of them. */
  const isActive  = row.is_active ?? row.active ?? true;
  const expiresAt = row.expires_at ?? row.valid_until ?? row.expiry ?? null;
  const maxUses   = row.max_uses ?? row.usage_limit ?? null;
  const usedCount = row.used_count ?? row.times_used ?? row.usage_count ?? 0;
  const minOrder  = row.min_order_amount ?? row.min_order ?? row.minimum_amount ?? 0;

  /* A column literally named "percent…" tells us the type by itself. */
  const percentCol =
    row.percent_off ?? row.discount_percent ?? row.percentage ?? row.percent ?? null;

  const type = percentCol !== null && percentCol !== undefined
    ? "percentage"
    : String(row.discount_type ?? row.type ?? row.kind ?? "percentage").toLowerCase();

  const value = Number(
    percentCol ??
    row.discount_value ?? row.value ?? row.amount ?? row.discount_amount ?? 0,
  );

  if (!Number.isFinite(value) || value <= 0) {
    throw new QuoteError("That promo code isn't valid.", "BAD_DISCOUNT");
  }

  if (!isActive) {
    throw new QuoteError("That promo code is no longer active.", "DISCOUNT_INACTIVE");
  }
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    throw new QuoteError("That promo code has expired.", "DISCOUNT_EXPIRED");
  }
  if (maxUses !== null && Number(usedCount) >= Number(maxUses)) {
    throw new QuoteError("That promo code has been fully redeemed.", "DISCOUNT_USED_UP");
  }
  if (minOrder && subtotalPaise < toPaise(minOrder)) {
    throw new QuoteError(
      `This code requires a minimum order of ₹${Number(minOrder).toLocaleString("en-IN")}.`,
      "DISCOUNT_MIN_ORDER",
    );
  }

  let discountPaise;
  if (type.startsWith("percent")) {
    discountPaise = Math.round(subtotalPaise * (value / 100));
  } else {
    discountPaise = toPaise(value);
  }
  /* A discount can never exceed the subtotal. */
  discountPaise = Math.max(0, Math.min(discountPaise, subtotalPaise));

  return { code, discountPaise, row, type, value };
}

/* ─── Main entry point ────────────────────────────────────── */
export async function buildQuote({ items: rawItems, discountCode, shippingMethod }) {
  const items = collapse(sanitiseItems(rawItems));

  /* 1. Real prices, straight from the database. */
  const ids  = [...new Set(items.map(i => i.product_id))];
  const list = ids.map(id => `"${id}"`).join(",");

  const products = await db.select(
    "products",
    `id=in.(${encodeURIComponent(list)})&select=id,name,price,is_active`,
  );

  const variants = await db.select(
    "product_variants",
    `product_id=in.(${encodeURIComponent(list)})&select=id,product_id,color,size,stock,sku`,
  );

  const byProduct = new Map(products.map(p => [p.id, p]));

  /* 2. Validate every line against the catalogue and stock. */
  const lines = items.map(it => {
    const product = byProduct.get(it.product_id);
    if (!product) {
      throw new QuoteError("One of the items in your bag is no longer available.", "PRODUCT_MISSING");
    }
    if (product.is_active === false) {
      throw new QuoteError(`"${product.name}" is no longer available.`, "PRODUCT_INACTIVE");
    }

    const variant = variants.find(v =>
      v.product_id === it.product_id && v.color === it.color && v.size === it.size);

    if (!variant) {
      throw new QuoteError(`"${product.name}" is not available in ${it.color} / ${it.size}.`, "VARIANT_MISSING");
    }
    if (Number(variant.stock) < it.quantity) {
      throw new QuoteError(
        Number(variant.stock) === 0
          ? `"${product.name}" (${it.color} / ${it.size}) is sold out.`
          : `Only ${variant.stock} left of "${product.name}" (${it.color} / ${it.size}).`,
        "OUT_OF_STOCK",
      );
    }

    const unitPricePaise = toPaise(product.price);
    return {
      product_id:   product.id,
      variant_id:   variant.id,
      sku:          variant.sku ?? null,
      name:         product.name,
      color:        it.color,
      size:         it.size,
      quantity:     it.quantity,
      unitPricePaise,
      linePaise:    unitPricePaise * it.quantity,
    };
  });

  /* 3. Money. Integers only. */
  const subtotalPaise = lines.reduce((sum, l) => sum + l.linePaise, 0);

  const discount = await validateDiscount(discountCode, subtotalPaise);
  const discountedPaise = subtotalPaise - discount.discountPaise;

  const method = PRICING.SHIPPING[shippingMethod] ? shippingMethod : "standard";
  const rule   = PRICING.SHIPPING[method];
  const shippingPaise =
    rule.freeOver !== null && discountedPaise >= toPaise(rule.freeOver)
      ? 0
      : toPaise(rule.price);

  /* GST is charged on the discounted goods value, not on shipping. */
  const taxPaise   = Math.round(discountedPaise * PRICING.GST_RATE);
  const totalPaise = discountedPaise + shippingPaise + taxPaise;

  if (totalPaise < 100) {
    throw new QuoteError("Order total is too low to process.", "AMOUNT_TOO_LOW");
  }

  return {
    lines,
    subtotalPaise,
    discountPaise: discount.discountPaise,
    discountCode:  discount.discountPaise > 0 ? discount.code : null,
    shippingMethod: method,
    shippingLabel:  rule.label,
    shippingPaise,
    taxPaise,
    totalPaise,
  };
}

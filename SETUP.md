# Kanka — Razorpay Payment Setup

Do these in order. Steps 1–4 take about 15 minutes.

---

## Step 1 — Run the SQL migration

Supabase dashboard → **SQL Editor** → **New query** → paste all of
`sql/01-razorpay-migration.sql` → **Run**.

You should see `Success. No rows returned`. It's safe to run twice.

This adds the payment columns to `orders`, the snapshot columns to
`order_items`, usage tracking to `discount_codes`, seeds `KANKA10`,
and creates the `fulfill_order()` function that both the callback and
the webhook call.

The migration inspects your `discount_codes` table and adapts to
whatever column names it already uses (`discount_type`/`discount_value`,
`type`/`value`, `percent_off`, and so on), adding columns only where
there's no equivalent. Watch the **Notices** panel — it prints which
columns it matched and whether it created or kept `KANKA10`.

If `KANKA10` already exists, the migration **does not touch its value** —
it only sets `is_active = true`. Changing the client's discount isn't
a migration's job.

**Sanity check** — run this after:

```sql
select * from discount_codes where upper(code) = 'KANKA10';
```

If you'd ever like to see the exact shape of the table:

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'discount_codes'
order by ordinal_position;
```

---

## Step 2 — Push the files to GitHub

Upload into `github.com/mithunvishnu66/kanka-`, keeping this structure:

```
kanka-/
├── index.html                    ← replaces your current one
├── package.json                  ← new (enables ESM in /api)
├── api/
│   ├── create-order.js
│   ├── verify-payment.js
│   ├── razorpay-webhook.js
│   ├── validate-discount.js
│   └── _lib/
│       ├── kanka.js
│       └── quote.js
└── sql/01-razorpay-migration.sql  (reference only)
```

The `_lib` folder name matters — Vercel treats underscore-prefixed
folders as shared code, not as public endpoints. Don't rename it.

There are **zero npm dependencies**. Nothing to install, no build step.

---

## Step 3 — Add environment variables in Vercel

Vercel dashboard → your project → **Settings** → **Environment
Variables**. For each row below: type the name in **Key**, the value in
**Value**, tick **Production**, **Preview** and **Development**, click **Save**.

| Key | Value | Notes |
|---|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…` | Publishable — reaches the browser by design |
| `RAZORPAY_KEY_SECRET` | from your Razorpay CSV | **Server only. Never in a file.** |
| `RAZORPAY_WEBHOOK_SECRET` | you'll create it in Step 4 | Add after Step 4 |
| `SUPABASE_URL` | `https://eyjpkpvhnepcwuttvynt.supabase.co` | |
| `SUPABASE_SERVICE_KEY` | your service_role key | **Bypasses all RLS. Server only.** |

Then **Deployments** → the top deployment → **⋯** → **Redeploy**.
Env vars only apply to builds made *after* they're saved.

---

## Step 4 — Register the webhook

Razorpay dashboard → **Account & Settings** → **Webhooks** → **+ Add New Webhook**.

- **Webhook URL:** `https://kanka-react.vercel.app/api/razorpay-webhook`
- **Secret:** invent a long random string. Paste the same value into
  Vercel as `RAZORPAY_WEBHOOK_SECRET`, then redeploy.
- **Active events** — tick exactly these four:
  - `payment.captured`
  - `payment.failed`
  - `order.paid`
  - `refund.processed`
- **Create Webhook**.

Razorpay sends a test ping. A green tick means the signature verified.

---

## Step 5 — Test end to end

Test cards (Test Mode only):

| Card | Result |
|---|---|
| `4111 1111 1111 1111` | Success |
| `5104 0600 0000 0008` | Success (Mastercard) |
| `4000 0000 0000 0002` | Failure |

Any future expiry, any CVV, OTP `1234`. UPI test id: `success@razorpay`.

**The walkthrough:**

1. Add an item to the bag → apply `KANKA10` → it should now say
   *"KANKA10 applied — 10% off"*. That text is coming from your
   database, not from the old hardcoded string.
2. Checkout → fill the address → pick shipping → the button reads
   **PAY ₹X**.
3. The Razorpay popup opens. Pay with `4111 1111 1111 1111`.
4. You land on the Order Confirmed screen with a `KNK-XXXXXX` number.

**Then verify server-side** — this is the part that actually matters:

```sql
select order_number, status, payment_status, total_amount,
       razorpay_payment_id, paid_at
from orders order by created_at desc limit 5;
```

`status` and `payment_status` should both read `paid`, with a
`razorpay_payment_id` and a `paid_at` timestamp.

Then confirm stock actually moved:

```sql
select p.name, v.color, v.size, v.stock
from product_variants v join products p on p.id = v.product_id
order by v.stock asc limit 10;
```

**The important test** — close the tab mid-payment. Pay, then kill the
browser before it redirects. The order should *still* flip to `paid`
within a few seconds, because the webhook doesn't care about the browser.
That's the whole point of having one.

**The other important test** — try to cheat:

```bash
curl -X POST https://kanka-react.vercel.app/api/verify-payment \
  -H "Content-Type: application/json" \
  -d '{"razorpay_order_id":"order_fake","razorpay_payment_id":"pay_fake","razorpay_signature":"abc123"}'
```

Must return `{"error":"Payment could not be verified.","verified":false}`.
If it ever returns anything else, stop and tell me.

---

## Going live (after KYC clears)

1. Razorpay dashboard → switch to **Live Mode** → generate live keys.
2. Update `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in Vercel.
3. Register the webhook **again** in Live Mode — test and live webhooks
   are separate. New secret → update `RAZORPAY_WEBHOOK_SECRET`.
4. Redeploy.
5. Make one real ₹1 purchase yourself, confirm it in the DB, then refund it.

---

## If something breaks

Vercel dashboard → your project → **Logs**, filter by function.

| Symptom | Cause |
|---|---|
| `Missing env vars: …` | Var not saved, or saved but not redeployed |
| `Cannot use import statement outside a module` | `package.json` missing from the repo root |
| Webhook shows red in Razorpay | `RAZORPAY_WEBHOOK_SECRET` doesn't match what you typed in Razorpay |
| `column … does not exist` | Step 1 migration didn't run |
| `KANKA10` gives the wrong % | Migration kept your existing row — edit `discount_codes` directly |
| Popup never opens | Checkout.js blocked — check the browser console |
| Order stuck `pending` after paying | Webhook not registered, or wrong URL |

Existing gotcha still applies: run `localStorage.clear()` in the console
after deploying, since old cached sessions and the old cart shape can
confuse the new checkout.

---

## Security notes

- Card numbers are typed inside Razorpay's iframe. They never touch
  `index.html` and never reach your server. PCI scope stays at zero.
- The browser sends only `product_id`, `color`, `size`, `quantity`.
  Every rupee is recomputed server-side from the database. Editing
  prices in devtools changes nothing.
- `verify-payment` checks the HMAC signature *and* re-fetches the
  payment from Razorpay to confirm the captured amount matches. A valid
  signature on a ₹1 payment for a ₹5,000 order is still rejected.
- `fulfill_order()` runs inside a single Postgres transaction with a row
  lock, so the callback and the webhook can't both decrement stock.
  Whoever gets there first does the work; the other is a no-op.
- The `service_role` key bypasses every RLS policy you wrote. It belongs
  in Vercel env vars and nowhere else — not in `index.html`, not in the
  repo, not in a chat.

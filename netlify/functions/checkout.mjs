// Trendbox online checkout: card + PromptPay through Stripe Checkout.
// Prices, stock and shipping are read from your site's shop-data.json on every order,
// so editing products with the Trendbox product editor updates payments too.
// Shoppers can't change prices: they only send SKU + quantity; prices come from your own file.

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: "STRIPE_SECRET_KEY is not set" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "Cart is empty" }, 400);

  const origin = new URL(req.url).origin;
  let shop;
  try {
    const r = await fetch(`${origin}/shop-data.json`, { cache: "no-store" });
    shop = await r.json();
  } catch { return json({ error: "Could not load shop data" }, 500); }

  // SKU -> { name, price, stock }
  const SKUS = {};
  for (const p of shop.products || []) {
    for (const v of p.variants || []) {
      SKUS[v.sku] = {
        name: p.name.th + (v.label ? ` (${v.label.th})` : ""),
        price: Number(v.price) || 0,
        stock: v.stock == null ? 20 : Number(v.stock),
      };
    }
  }
  const FREE_SHIP = Number(shop.settings?.freeShip) || 0;
  const SHIP_FEE = Number(shop.settings?.shipFee) || 0;

  const form = new URLSearchParams();
  let i = 0, subtotal = 0;
  for (const { sku, qty } of items) {
    const p = SKUS[sku];
    const q = Math.max(1, Math.min(20, parseInt(qty, 10) || 1));
    if (!p || !p.price || p.stock <= 0) return json({ error: `Unknown, unpriced or sold-out item ${sku}` }, 400);
    if (q > p.stock) return json({ error: `Only ${p.stock} left of ${p.name}` }, 400);
    subtotal += p.price * q;
    form.append(`line_items[${i}][price_data][currency]`, "thb");
    form.append(`line_items[${i}][price_data][product_data][name]`, p.name);
    form.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(p.price * 100))); // satang
    form.append(`line_items[${i}][quantity]`, String(q));
    i++;
  }
  if (SHIP_FEE > 0 && subtotal < FREE_SHIP) {
    form.append(`line_items[${i}][price_data][currency]`, "thb");
    form.append(`line_items[${i}][price_data][product_data][name]`, "ค่าจัดส่ง / Shipping");
    form.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(SHIP_FEE * 100)));
    form.append(`line_items[${i}][quantity]`, "1");
  }

  form.append("mode", "payment");
  form.append("payment_method_types[0]", "card");
  form.append("payment_method_types[1]", "promptpay");
  form.append("shipping_address_collection[allowed_countries][0]", "TH");
  form.append("phone_number_collection[enabled]", "true");
  form.append("locale", body.lang === "en" ? "en" : "th");
  form.append("success_url", `${origin}/#thanks`);
  form.append("cancel_url", `${origin}/#cancel`);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || "Stripe error" }, 502);
  return json({ url: data.url });
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

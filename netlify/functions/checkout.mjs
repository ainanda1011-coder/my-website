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

  const L = body.lang === "en" ? "en" : "th";
  const abs = (u) => { try { const x = new URL(u, origin + "/"); return x.protocol === "https:" ? x.href : null; } catch { return null; } };

  // SKU -> { name, desc, image, price, stock }
  const SKUS = {};
  for (const p of shop.products || []) {
    const pname = (p.name && (p.name[L] || p.name.th)) || "";
    for (const v of p.variants || []) {
      const label = v.label ? (v.label[L] || v.label.th) : "";
      const desc = [label && (L === "en" ? `Option: ${label}` : `ตัวเลือก: ${label}`), p.desc && (p.desc[L] || p.desc.th)].filter(Boolean).join(" · ");
      SKUS[v.sku] = {
        name: pname + (label ? ` (${label})` : ""),
        desc,
        image: [v.image, ...(Array.isArray(p.images) ? p.images : []), p.img].map(u => u && abs(u)).find(Boolean) || null,
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
    if (p.desc) form.append(`line_items[${i}][price_data][product_data][description]`, p.desc.slice(0, 500));
    if (p.image) form.append(`line_items[${i}][price_data][product_data][images][0]`, p.image);
    form.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(p.price * 100))); // satang
    form.append(`line_items[${i}][quantity]`, String(q));
    i++;
  }
  // Shipping shown as its own row ("Free" when no fee), with a 2–4 business day estimate
  const fee = SHIP_FEE > 0 && subtotal < FREE_SHIP ? SHIP_FEE : 0;
  const S = "shipping_options[0][shipping_rate_data]";
  form.append(`${S}[type]`, "fixed_amount");
  form.append(`${S}[fixed_amount][amount]`, String(Math.round(fee * 100)));
  form.append(`${S}[fixed_amount][currency]`, "thb");
  form.append(`${S}[display_name]`, fee ? (L === "en" ? "Standard delivery" : "จัดส่งมาตรฐาน")
                                          : (L === "en" ? "Free delivery (Flash, Kerry or Thailand Post)" : "ส่งฟรี (Flash, Kerry หรือไปรษณีย์ไทย)"));
  form.append(`${S}[delivery_estimate][minimum][unit]`, "business_day");
  form.append(`${S}[delivery_estimate][minimum][value]`, "2");
  form.append(`${S}[delivery_estimate][maximum][unit]`, "business_day");
  form.append(`${S}[delivery_estimate][maximum][value]`, "4");

  // Reassurance text on the payment page
  const lineId = shop.settings?.lineId || "";
  if (!(body.customer && body.customer.line1)) form.append("custom_text[shipping_address][message]", L === "en"
    ? "We ship from Bangkok within 1 business day and send your tracking number on LINE."
    : "เราจัดส่งจากกรุงเทพฯ ภายใน 1 วันทำการ และแจ้งเลขพัสดุให้ทาง LINE");
  form.append("custom_text[submit][message]", L === "en"
    ? `Secure payment by Stripe. We never see or store your card details. Questions? Chat with us on LINE ${lineId}.`
    : `ชำระเงินปลอดภัยผ่าน Stripe ร้านค้าไม่เห็นและไม่เก็บข้อมูลบัตรของคุณ มีคำถาม? ทักเราทาง LINE ${lineId}`);
  form.append("submit_type", "pay");

  form.append("mode", "payment");
  const method = ["card", "promptpay"].includes(body.method) ? body.method : null;
  if (method) form.append("payment_method_types[0]", method);
  else { form.append("payment_method_types[0]", "card"); form.append("payment_method_types[1]", "promptpay"); }

  // Address from the site's own checkout page: pass it to Stripe so customers don't type it twice
  const c = body.customer && typeof body.customer === "object" ? body.customer : null;
  const cs = (v, n = 200) => String(v || "").trim().slice(0, n);
  if (c && cs(c.name) && cs(c.line1) && cs(c.province) && /^\d{5}$/.test(cs(c.postal))) {
    const P = "payment_intent_data[shipping]";
    form.append(`${P}[name]`, cs(c.name));
    form.append(`${P}[phone]`, cs(c.phone, 20));
    form.append(`${P}[address][line1]`, cs(c.line1));
    form.append(`${P}[address][city]`, cs(c.district));
    form.append(`${P}[address][state]`, cs(c.province));
    form.append(`${P}[address][postal_code]`, cs(c.postal, 5));
    form.append(`${P}[address][country]`, "TH");
    form.append("metadata[customer_name]", cs(c.name));
    form.append("metadata[customer_phone]", cs(c.phone, 20));
    form.append("metadata[delivery_address]", cs(`${c.line1}, ${c.district}, ${c.province} ${c.postal}`, 480));
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cs(c.email))) form.append("customer_email", cs(c.email));
  } else {
    form.append("shipping_address_collection[allowed_countries][0]", "TH");
    form.append("phone_number_collection[enabled]", "true");
  }
  form.append("locale", L);
  form.append("success_url", `${origin}/#thanks`);
  form.append("cancel_url", `${origin}/#cancel`);

  const send = (f) => fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  let res = await send(form);
  let data = await res.json();
  if (!res.ok && /shipping_options/.test(data.error?.message || "")) {
    // Fallback: some Stripe setups only allow shipping options when Stripe collects the address
    const f2 = new URLSearchParams([...form].filter(([k]) => !k.startsWith("shipping_options")));
    res = await send(f2); data = await res.json();
  }
  if (!res.ok) return json({ error: data.error?.message || "Stripe error" }, 502);
  return json({ url: data.url });
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

/**
 * POST /api/webhook  <-  Shopify `orders/updated`
 *
 * Fires a Meta CAPI `VerifiedPurchase` when an order gains a confirm tag.
 * Dedupes by writing `capi-sent` back onto the order, so no external store.
 *
 * Env:
 *   SHOPIFY_WEBHOOK_SECRET, META_DATASET_ID, META_ACCESS_TOKEN   (required)
 *   META_TEST_EVENT_CODE  optional - send to Events Manager > Test events only
 *   ALLOWED_SOURCES       optional - e.g. "web". Unset = log source, never block
 *   DRY_RUN               optional - log payload, send nothing
 */

import {
  sha256,
  normalisePhone,
  verifyShopifyHmac,
  tagList,
  attr,
  shopifyBase,
  shopifyHeaders,
  json,
} from '../lib/util.js';

export const config = { runtime: 'edge' };

const CONFIRM_TAGS = ['confirmed', 'confirm', 'confrim']; // typo tolerated
const SENT_TAG = 'capi-sent';

// NEW: mirrors Purchase's customer_segmentation values. Only sent when Shopify
// includes the customer's order count; otherwise omitted (wrong > missing).
function segmentation(order) {
  const count = order.customer && order.customer.orders_count;
  if (typeof count !== 'number') {
    console.log('NO orders_count — customer_segmentation omitted', order.name);
    return {};
  }
  return {
    customer_segmentation: [
      count <= 1 ? 'new_customer_to_business' : 'existing_customer_to_business',
    ],
  };
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  // MUST read the raw body before parsing — HMAC is over the exact bytes.
  const raw = await request.text();

  const valid = await verifyShopifyHmac(
    raw,
    request.headers.get('x-shopify-hmac-sha256'),
    process.env.SHOPIFY_WEBHOOK_SECRET
  );
  if (!valid) return json({ error: 'bad hmac' }, 401);

  const order = JSON.parse(raw);
  const tags = tagList(order);

  console.log('WEBHOOK', JSON.stringify({
    order: order.name,
    id: order.id,
    tags,
    cancelled_at: order.cancelled_at,
    source_name: order.source_name, // NEW: shows manual vs website orders
    test: order.test,               // NEW
  }));

  // Gate 1 — confirmed?
  if (!tags.some((t) => CONFIRM_TAGS.includes(t))) {
    console.log('SKIP: not confirmed', order.name, tags);
    return json({ skipped: 'not confirmed', tags });
  }
  // Gate 2 — already sent?
  if (tags.includes(SENT_TAG)) {
    console.log('SKIP: already sent', order.name);
    return json({ skipped: 'already sent' });
  }
  // Gate 3 — cancelled?
  if (order.cancelled_at) {
    console.log('SKIP: cancelled', order.name);
    return json({ skipped: 'cancelled' });
  }
  // Gate 4 (NEW) — Shopify test order?
  if (order.test) {
    console.log('SKIP: test order', order.name);
    return json({ skipped: 'test' });
  }
  // Gate 5 (NEW, off by default) — only enforced when ALLOWED_SOURCES is set.
  const allowed = (process.env.ALLOWED_SOURCES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const source = String(order.source_name || '').toLowerCase();
  if (allowed.length && !allowed.includes(source)) {
    console.log('SKIP: source not allowed', order.name, source);
    return json({ skipped: 'source', source });
  }
  console.log('PASSED GATES', order.name);

  const ship = order.shipping_address || order.billing_address || {};
  const cd = order.client_details || {};
  const phone = normalisePhone(
    order.phone || ship.phone || (order.customer && order.customer.phone)
  );

  const user_data = {
    ph: [await sha256(phone)],
    em: [await sha256(order.email)],
    fn: [await sha256(ship.first_name)],
    ln: [await sha256(ship.last_name)],
    ct: [await sha256(ship.city)],
    zp: [await sha256(ship.zip)],                     // NEW
    country: [await sha256(ship.country_code || 'pk')],
    // Never hashed:
    fbp: attr(order, '_fbp'),
    fbc: attr(order, '_fbc'),
    client_user_agent: attr(order, '_user_agent') || cd.user_agent, // NEW fallback
    client_ip_address: order.browser_ip || cd.browser_ip,           // NEW
  };
  for (const k of Object.keys(user_data)) {
    const v = user_data[k];
    if (!v || (Array.isArray(v) && !v.filter(Boolean).length)) delete user_data[k];
    else if (Array.isArray(v)) user_data[k] = v.filter(Boolean);
  }

  // NEW: catalog retailer_id = Shopify VARIANT ID (same as Purchase event).
  const items = order.line_items || [];
  if (items.some((li) => !li.variant_id)) {
    console.warn('NO VARIANT ID — item will not match catalog', order.name);
  }
  const idOf = (li) => String(li.variant_id || li.product_id);

  const payload = {
    data: [
      {
        event_name: 'VerifiedPurchase',
        // Tag time, not order time — keeps a 3am order confirmed at 9am
        // inside Meta's freshness window.
        event_time: Math.floor(Date.now() / 1000),
        event_id: `toyify-${order.id}`, // stable => retries dedupe
        action_source: 'website',
        event_source_url: 'https://toyify.pk/',
        user_data,
        custom_data: {
          currency: order.currency || 'PKR',
          // CHECK in Test events: if Purchase excludes shipping, use subtotal_price.
          value: Number(order.total_price || 0),
          // FIXED: Purchase sends Shopify's internal order.id, not order_number.
          order_id: String(order.id),
          content_type: 'product',                                   // NEW
          content_ids: [...new Set(items.map(idOf))],                // NEW
          contents: items.map((li) => ({
            id: idOf(li),                                            // FIXED (was sku)
            quantity: li.quantity,
            item_price: Number(li.price),
          })),
          num_items: items.reduce((s, li) => s + (li.quantity || 0), 0), // NEW
          ...segmentation(order), // NEW: same values as Purchase
        },
      },
    ],
    access_token: process.env.META_ACCESS_TOKEN, // CHANGED: body, not URL (keeps it out of logs)
  };
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE; // NEW
  }

  if (process.env.DRY_RUN) {
    const { access_token, ...safe } = payload;
    console.log('DRY RUN payload', JSON.stringify(safe));
    return json({ dry_run: true });
  }

  const metaRes = await fetch(
    `https://graph.facebook.com/v21.0/${process.env.META_DATASET_ID}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const metaBody = await metaRes.json();

  if (!metaRes.ok) {
    // 500 so Shopify retries. Do NOT tag as sent.
    console.error('CAPI failed', order.name, JSON.stringify(metaBody));
    return json({ error: 'capi', detail: metaBody }, 500);
  }

  // NEW: in test mode don't tag, so the real event still fires later.
  if (process.env.META_TEST_EVENT_CODE) {
    console.log('TEST EVENT sent, not tagging', order.name);
    return json({ sent: true, test: true, events_received: metaBody.events_received });
  }

  // Mark sent so the next orders/updated is a no-op.
  // CHANGED: keep original tag casing (tagList lowercases) + log failures.
  const tagRes = await fetch(`${shopifyBase()}/orders/${order.id}.json`, {
    method: 'PUT',
    headers: await shopifyHeaders(),
    body: JSON.stringify({
      order: { id: order.id, tags: [order.tags, SENT_TAG].filter(Boolean).join(', ') },
    }),
  });
  if (!tagRes.ok) {
    console.error('TAG WRITE FAILED', order.name, tagRes.status, await tagRes.text());
  }

  return json({ sent: true, events_received: metaBody.events_received });
}

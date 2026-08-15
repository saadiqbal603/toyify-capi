/**
 * POST /api/webhook  <-  Shopify `orders/updated`
 *
 * Fires a Meta CAPI `VerifiedPurchase` when an order gains a confirm tag.
 * Dedupes by writing `capi-sent` back onto the order, so no external store.
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

  // Gate 1 — confirmed?
  if (!tags.some((t) => CONFIRM_TAGS.includes(t))) {
    return json({ skipped: 'not confirmed' });
  }
  // Gate 2 — already sent? orders/updated fires on every edit.
  if (tags.includes(SENT_TAG)) {
    return json({ skipped: 'already sent' });
  }
  // Gate 3 — never report a cancelled order as a purchase.
  if (order.cancelled_at) {
    return json({ skipped: 'cancelled' });
  }

  const ship = order.shipping_address || order.billing_address || {};
  const phone = normalisePhone(
    order.phone || ship.phone || (order.customer && order.customer.phone)
  );

  const user_data = {
    ph: [await sha256(phone)],
    em: [await sha256(order.email)],
    fn: [await sha256(ship.first_name)],
    ln: [await sha256(ship.last_name)],
    ct: [await sha256(ship.city)],
    country: [await sha256(ship.country_code || 'pk')],
    // Never hashed:
    fbp: attr(order, '_fbp'),
    fbc: attr(order, '_fbc'),
    client_user_agent: attr(order, '_user_agent'),
  };
  for (const k of Object.keys(user_data)) {
    const v = user_data[k];
    if (!v || (Array.isArray(v) && !v.filter(Boolean).length)) delete user_data[k];
    else if (Array.isArray(v)) user_data[k] = v.filter(Boolean);
  }

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
          value: Number(order.total_price || 0),
          order_id: String(order.order_number || order.id),
          contents: (order.line_items || []).map((li) => ({
            id: String(li.sku || li.product_id),
            quantity: li.quantity,
            item_price: Number(li.price),
          })),
        },
      },
    ],
  };
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  const metaRes = await fetch(
    `https://graph.facebook.com/v21.0/${process.env.META_DATASET_ID}/events` +
      `?access_token=${process.env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const metaBody = await metaRes.json();

  if (!metaRes.ok) {
    // 500 so Shopify retries. Do NOT tag as sent.
    console.error('CAPI failed', JSON.stringify(metaBody));
    return json({ error: 'capi', detail: metaBody }, 500);
  }

  // Mark sent so the next orders/updated is a no-op.
  await fetch(`${shopifyBase()}/orders/${order.id}.json`, {
    method: 'PUT',
    headers: await shopifyHeaders(),
    body: JSON.stringify({
      order: { id: order.id, tags: [...tags, SENT_TAG].join(', ') },
    }),
  });

  return json({ sent: true, events_received: metaBody.events_received });
}

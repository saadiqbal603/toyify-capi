/**
 * POST /api/capture  <-  Shopify custom pixel (checkout_completed)
 *
 * Writes _fbp / _fbc / _user_agent onto the order as note attributes, merging
 * with anything the theme snippet already stored. Fires on every checkout path
 * including "Buy it now", which bypasses the cart entirely.
 */

import { shopifyBase, shopifyHeaders, json } from '../lib/util.js';

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': 'https://toyify.pk',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(request) {
  // The pixel runs in a sandboxed iframe — preflight is required.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return new Response('method', { status: 405, headers: CORS });
  }

  const body = await request.json().catch(() => null);
  if (!body || body.token !== process.env.CAPTURE_TOKEN) {
    return new Response('unauthorised', { status: 401, headers: CORS });
  }

  const orderId = String(body.order_id || '').replace(/\D/g, '');
  if (!orderId) return new Response('bad order id', { status: 400, headers: CORS });

  // Read existing attributes so we merge rather than clobber.
  const res = await fetch(
    `${shopifyBase()}/orders/${orderId}.json?fields=id,note_attributes`,
    { headers: await shopifyHeaders() }
  );
  if (!res.ok) return new Response('lookup failed', { status: 502, headers: CORS });
  const { order } = await res.json();

  const merged = new Map(
    (order.note_attributes || []).map((a) => [a.name, a.value])
  );
  // Only fill gaps — snippet values came from the real browsing session.
  if (body.fbp && !merged.get('_fbp')) merged.set('_fbp', body.fbp);
  if (body.fbc && !merged.get('_fbc')) merged.set('_fbc', body.fbc);
  if (body.user_agent && !merged.get('_user_agent')) {
    merged.set('_user_agent', body.user_agent);
  }

  const put = await fetch(`${shopifyBase()}/orders/${orderId}.json`, {
    method: 'PUT',
    headers: await shopifyHeaders(),
    body: JSON.stringify({
      order: {
        id: Number(orderId),
        note_attributes: [...merged].map(([name, value]) => ({ name, value })),
      },
    }),
  });
  if (!put.ok) return new Response('write failed', { status: 502, headers: CORS });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

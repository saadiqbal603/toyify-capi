// Shared helpers. Runs on Vercel's Edge runtime (Web Crypto, no node builtins).

const enc = new TextEncoder();

/** Meta requires lowercase + trimmed before SHA-256. */
export async function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const normalised = String(value).trim().toLowerCase();
  if (!normalised) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(normalised));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Pakistani mobile -> digits only, country code, no leading +. */
export function normalisePhone(raw) {
  if (!raw) return undefined;
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) return d;
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length === 10 && d.startsWith('3')) return '92' + d;
  return d.length >= 11 ? d : undefined;
}

/** Verify Shopify's webhook signature against the RAW body string. */
export async function verifyShopifyHmac(rawBody, header, secret) {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

export function tagList(order) {
  return String(order.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Read a cart/note attribute off an order, case-insensitively. */
export function attr(order, name) {
  const hit = (order.note_attributes || []).find(
    (a) => a.name && a.name.toLowerCase() === name.toLowerCase()
  );
  return hit && hit.value ? hit.value : undefined;
}

export const API_VERSION = '2025-07';

/**
 * Dev Dashboard apps have no static token. We exchange client id + secret via
 * the client credentials grant. Tokens live 24h, so cache in module scope and
 * refresh 5 minutes early. A cold isolate just fetches a fresh one.
 */
let _token = null;
let _expiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (_token && now < _expiresAt) return _token;

  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  _token = data.access_token;
  _expiresAt = now + (data.expires_in || 86399) * 1000 - 5 * 60 * 1000;
  return _token;
}

export async function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': await getAccessToken(),
    'Content-Type': 'application/json',
  };
}

export function shopifyBase() {
  return `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}`;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

# Toyify — Meta CAPI pipeline

Two Vercel Edge Functions:

| Route | Trigger | Job |
|---|---|---|
| `/api/capture` | Shopify custom pixel, `checkout_completed` | Write `_fbp` / `_fbc` / `_user_agent` onto the order |
| `/api/webhook` | Shopify `orders/updated` | On a confirm tag, send `VerifiedPurchase` to Meta CAPI |

Edge runtime, Web Crypto only, no dependencies. `npm install` does nothing —
there is nothing to install.

---

## 1. Get your credentials

**Shopify** — admin custom apps were removed on 1 Jan 2026. Use the Dev Dashboard.

1. Admin → Settings → Apps and sales channels → Develop apps → **Build apps in Dev Dashboard**
2. **Create app** → under *Start from Dev Dashboard*, name it `Toyify CAPI` → Create
3. On the version page:
   - **App URL**: `https://shopify.dev/apps/default-app-home` (not embedded, so the default is fine)
   - **Webhooks API version**: latest
   - **Access / scopes**: `read_orders`, `write_orders`
   - **Release**
4. **Distribution** → Custom distribution → single store → `15zsjm-1g.myshopify.com` → get the install link and install it
5. Copy **Client ID** → `SHOPIFY_CLIENT_ID` and **Client secret** → `SHOPIFY_CLIENT_SECRET`

There is no `shpat_` token any more. `lib/util.js` exchanges the client id and
secret for a 24h token via the client credentials grant, caches it in module
scope, and refreshes 5 minutes before expiry. Nothing for you to manage.

The client secret is also what signs your webhooks, so it does double duty.

**Meta** — Business Settings → Users → System Users → Add

- Assign to ad account `2018554702228044` with full control
- Generate token with `ads_management`. Shown once → `META_ACCESS_TOKEN`
- Events Manager → your dataset → Settings → Dataset ID → `META_DATASET_ID`
- Events Manager → Test Events → copy the code → `META_TEST_EVENT_CODE`

**Capture token** — generate any long random string:

```bash
openssl rand -hex 32
```

---

## 2. Deploy

```bash
npm i -g vercel
cd toyify-capi
vercel            # first run: link/create the project
```

Add environment variables (repeat for each, or paste them in the Vercel
dashboard under Settings → Environment Variables):

```bash
vercel env add SHOPIFY_SHOP production          # 15zsjm-1g.myshopify.com
vercel env add SHOPIFY_CLIENT_ID production
vercel env add SHOPIFY_CLIENT_SECRET production
vercel env add META_DATASET_ID production
vercel env add META_ACCESS_TOKEN production
vercel env add META_TEST_EVENT_CODE production
vercel env add CAPTURE_TOKEN production
```

Then ship it:

```bash
vercel --prod
```

Note your production URL, e.g. `https://toyify-capi.vercel.app`.

**Env vars are only read at deploy time.** After adding or changing any of
them you must run `vercel --prod` again, or the functions keep the old values.

---

## 3. Wire up Shopify

**Custom pixel** — Settings → Customer events → Add custom pixel

Paste `custom-pixel-fb-capture.js`, replacing:

- `https://YOUR-WORKER-URL/capture` → `https://toyify-capi.vercel.app/api/capture`
- `REPLACE_WITH_A_LONG_RANDOM_STRING` → your `CAPTURE_TOKEN`

Save, then **Connect**. A saved-but-unconnected pixel does not run.

**Webhook** — Settings → Notifications → Webhooks → Create webhook

- Event: **Order updated**
- Format: JSON
- URL: `https://toyify-capi.vercel.app/api/webhook`

---

## 4. Test

**Capture** — place a test order using **Buy it now** (the path that used to
fail). Open the order in admin → Additional Details. You should see `_fbp`
and/or `_fbc`.

**CAPI** — tag that order `confirmed`. Watch Events Manager → Test Events for
`VerifiedPurchase`. Check `fbp`/`fbc` are populated and the value matches.

Then tag it again — the second webhook should return `already sent`. That
proves dedupe works.

Logs: `vercel logs --follow`

---

## 5. Go live

Remove `META_TEST_EVENT_CODE`:

```bash
vercel env rm META_TEST_EVENT_CODE production
vercel --prod
```

Monitor for two weeks in Events Manager:

- **Volume** — expect roughly 9–10/day. You need ~50/week before optimising.
- **Event Match Quality** — 6+ is workable. Below 5 means `fbp`/`fbc` coverage
  is still too low; recheck capture before going further.

Only create the custom conversion once both look healthy, and run it as a
reporting column for 2–3 weeks before switching any ad set's optimisation
event to it.

---

## Gotchas

- **HMAC is over the raw body.** These are Edge functions using
  `request.text()`, so this is already correct. Don't refactor to
  `request.json()` before verifying.
- **`orders/updated` is noisy.** It fires on every edit. The `capi-sent` tag
  is what stops duplicate purchases — don't remove it.
- **Confirm tag spellings.** `CONFIRM_TAGS` in `api/webhook.js` matches
  `confirmed`, `confirm`, and the typo `confrim`. Standardise your team on
  `confirmed` anyway.
- **Instagram in-app browser** often has no `_fbp` cookie at all. Expect
  70–85% coverage, not 100%.

/**
 * Toyify — Shopify Custom Pixel
 * Settings > Customer events > Add custom pixel > paste this > Save > Connect
 *
 * WHY THIS INSTEAD OF CART ATTRIBUTES:
 * "Buy it now" / Shop Pay skip the cart entirely, so cart attributes never
 * attach. checkout_completed fires on every path. browser.cookie.get() reads
 * the real storefront cookies from inside the pixel sandbox.
 *
 * Permissions: this pixel needs no customer consent for analytics in PK, but
 * if you later enable Shopify's consent banner, set the pixel to "Analytics".
 */

analytics.subscribe('checkout_completed', async (event) => {
  try {
    const checkout = event.data && event.data.checkout;
    const orderId = checkout && checkout.order && checkout.order.id;
    if (!orderId) return;

    // browser.cookie.get() proxies to the top-level storefront context.
    const [fbp, fbc] = await Promise.all([
      browser.cookie.get('_fbp'),
      browser.cookie.get('_fbc'),
    ]);

    // Nothing worth sending — bail rather than writing empty attributes.
    if (!fbp && !fbc) return;

    await fetch('https://YOUR-WORKER-URL/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true, // survives the page unloading
      body: JSON.stringify({
        order_id: String(orderId),
        fbp: fbp || null,
        fbc: fbc || null,
        user_agent: navigator.userAgent,
        // Shared secret so the endpoint isn't openly writable.
        token: 'REPLACE_WITH_A_LONG_RANDOM_STRING',
      }),
    });
  } catch (e) {
    // Never let the pixel throw — it must not affect checkout.
  }
});

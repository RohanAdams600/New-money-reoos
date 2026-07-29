// Handles turning a pricing tier into an actual purchase. Falls back to a free
// demo-mode "purchase" (instant activation, no payment) when Stripe isn't
// configured — mirrors the DEMO_MODE pattern in claudeService.js so the whole
// buy -> use flow can be exercised end-to-end before any real payment setup.

function looksLikeRealStripeKey(key) {
  return typeof key === 'string' && /^sk_(test|live)_[A-Za-z0-9]{10,}$/.test(key);
}

const BILLING_DEMO_MODE = process.env.DEMO_MODE === 'true' || !looksLikeRealStripeKey(process.env.STRIPE_SECRET_KEY);

if (BILLING_DEMO_MODE) {
  console.warn('⚠️  Billing running in DEMO MODE — "purchases" activate instantly with no real payment. Add a real STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) to charge real cards.');
}

let stripeClient;
function getStripe() {
  if (!stripeClient) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// customerId is passed through as client_reference_id + metadata so the webhook
// (or the demo success redirect) knows which internal customer record to activate.
async function createCheckoutSession({ plan, customerId, baseUrl }) {
  if (BILLING_DEMO_MODE) {
    return { url: `${baseUrl}/checkout/success?demo=true&customerId=${customerId}`, demoMode: true };
  }

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: `LeadQualify AI — ${plan.name}` },
          unit_amount: plan.priceMonthly * 100,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
    client_reference_id: customerId,
    metadata: { customerId, planId: plan.id },
    success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout/cancel`,
  });

  return { url: session.url, demoMode: false };
}

async function retrieveSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId);
}

function verifyWebhookEvent(rawBody, signature) {
  return getStripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  BILLING_DEMO_MODE,
  createCheckoutSession,
  retrieveSession,
  verifyWebhookEvent,
};

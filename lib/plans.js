// Single source of truth for pricing tiers — used by both the business-info
// display and the checkout/billing flow, so the price a customer is shown is
// always exactly the price they're charged.
const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 1500,
    priceFormatted: '$1,500/month',
    tagline: 'For agencies just getting started with automated lead qualification',
    features: [
      'Up to 200 classified leads/month',
      'HOT / WARM / COLD classification',
      'Real-time dashboard & stats',
      '1 webhook, standard qualifying questions template',
      'Email support (48-hour response)',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 4500,
    priceFormatted: '$4,500/month',
    tagline: 'Our target plan — built for growing agencies with high lead flow',
    featured: true,
    features: [
      'Unlimited classified leads',
      'Full dashboard: live metrics, lead log, CSV export',
      'Fully customizable ICP & qualifying questions',
      'Edit/manage customer profiles, in-browser lead testing',
      'Priority email + chat support (same-day response)',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: 45000,
    priceFormatted: '$45,000/month',
    tagline: 'For agency networks, franchises, and holding companies running multiple brands at scale',
    features: [
      'Everything in Growth, across unlimited sub-brands/webhooks',
      'Dedicated account manager & onboarding',
      'Custom-tuned classification criteria per brand',
      'White-label dashboard (your branding, not ours)',
      'API access for direct CRM/telephony integration',
      'SLA-backed uptime & dedicated infrastructure',
    ],
  },
];

function getPlan(id) {
  return PLANS.find((p) => p.id === id);
}

module.exports = { PLANS, getPlan };

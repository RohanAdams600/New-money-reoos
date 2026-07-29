require('dotenv').config();
const express = require('express');
const path = require('path');

const store = require('./lib/store');
const { classifyLead, MODEL, DEMO_MODE } = require('./lib/claudeService');
const { PLANS, getPlan } = require('./lib/plans');
const billing = require('./lib/billingService');
const prospectStore = require('./lib/prospectStore');

const app = express();
const PORT = process.env.PORT || 3000;

const BUSINESS_INFO = {
  name: 'LeadQualify AI',
  email: 'rohanadams352@gmail.com',
  website: 'leadqualify.ai',
  description:
    'We automate lead qualification for agencies using AI—respond to every lead in 60 seconds, qualify automatically, and only show your team the ready-to-buy prospects.',
  targetCustomer: 'Digital Marketing Agencies (5-25 people)',
  painPoint:
    'Wasting 15-20 hours/week filtering low-quality leads while prospects go cold waiting for responses',
  pricingTiers: PLANS,
};

// Stripe webhook needs the raw request body for signature verification, so it must
// be registered with express.raw() BEFORE the global express.json() below — once
// express.json() runs for a request, the raw body is gone.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = billing.verifyWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[stripe/webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerId = session.client_reference_id;
    if (customerId && store.getCustomer(customerId)) {
      store.setCustomerPlan(customerId, session.metadata?.planId || null, 'active');
      store.setStripeIds(customerId, {
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
      });
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customer = store.findCustomerByStripeSubscription(subscription.id);
    if (customer) {
      store.setCustomerPlan(customer.id, customer.planId, 'canceled');
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function serializeCustomer(customer, { includeLeads = false } = {}) {
  const serialized = {
    id: customer.id,
    name: customer.name,
    description: customer.description,
    icpSize: customer.icpSize,
    icpBudget: customer.icpBudget,
    qualifyingQuestions: customer.qualifyingQuestions,
    createdAt: customer.createdAt,
    webhookUrl: `/webhook/${customer.id}`,
    stats: customer.stats,
    planId: customer.planId,
    billingStatus: customer.billingStatus,
  };
  if (includeLeads) {
    serialized.leads = customer.leads;
  }
  return serialized;
}

function successPageHtml({ webhookUrl, planName }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>You're all set — LeadQualify AI</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #1f2937; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); padding: 2.5rem; max-width: 480px; text-align: center; }
  h1 { background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; background-clip: text; color: transparent; margin-top: 0; }
  .webhook { font-family: monospace; background: #f3f4f6; padding: 0.6rem 0.8rem; border-radius: 8px; word-break: break-all; margin: 1rem 0; font-size: 0.85rem; }
  a.btn { display: inline-block; margin-top: 1rem; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; padding: 0.7rem 1.5rem; border-radius: 8px; text-decoration: none; font-weight: 600; }
</style></head>
<body>
  <div class="card">
    <h1>You're all set!</h1>
    <p>Welcome to LeadQualify AI on the <strong>${escapeHtmlServer(planName || 'selected')}</strong> plan.</p>
    <p>Your unique webhook URL — point your CRM/lead forms at this to start classifying leads automatically:</p>
    <div class="webhook">${escapeHtmlServer(webhookUrl)}</div>
    <p>Finish setting your ICP criteria and qualifying questions from the dashboard.</p>
    <a class="btn" href="/">Go to Dashboard</a>
  </div>
</body></html>`;
}

function escapeHtmlServer(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function parseQualifyingQuestions(input) {
  if (Array.isArray(input)) {
    return input.map((q) => String(q).trim()).filter(Boolean);
  }
  return String(input || '')
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean);
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function leadsToCsv(leads) {
  const header = ['Received At', 'Classification', 'Confidence', 'Company', 'Problem', 'Budget', 'Raw Message', 'Response Sent'];
  const rows = leads.map((l) => [
    l.receivedAt,
    l.classification,
    l.confidence,
    l.companyName,
    l.problem,
    l.budget,
    l.rawMessage,
    l.responseText,
  ].map(csvEscape).join(','));
  return [header.join(','), ...rows].join('\n');
}

// GET / — main admin dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET /health — health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: MODEL,
    demoMode: DEMO_MODE,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// GET /api/config — flags the dashboard needs (e.g. whether demo mode is active)
app.get('/api/config', (req, res) => {
  res.json({ demoMode: DEMO_MODE, model: MODEL });
});

// GET /api/business-info — business details for the dashboard
app.get('/api/business-info', (req, res) => {
  res.json(BUSINESS_INFO);
});

// GET /api/stats — aggregate metrics across every customer
app.get('/api/stats', (req, res) => {
  res.json(store.getAggregateStats());
});

// GET /api/customers — list all customers, including lead logs, for the dashboard
app.get('/api/customers', (req, res) => {
  res.json(store.listCustomers().map((c) => serializeCustomer(c, { includeLeads: true })));
});

// POST /api/customer/create — add a new customer
app.post('/api/customer/create', (req, res) => {
  const { name, description, icpSize, icpBudget, qualifyingQuestions } = req.body || {};

  if (!name || !description) {
    return res.status(400).json({ error: 'name and description are required.' });
  }

  const customer = store.createCustomer({
    name,
    description,
    icpSize: icpSize || 'Not specified',
    icpBudget: icpBudget || 'Not specified',
    qualifyingQuestions: parseQualifyingQuestions(qualifyingQuestions),
  });

  res.status(201).json(serializeCustomer(customer));
});

// GET /api/customer/:customerId/stats — one customer's stats + lead log.
// Optional ?classification=hot|warm|cold filters the returned lead log.
app.get('/api/customer/:customerId/stats', (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }
  const serialized = serializeCustomer(customer, { includeLeads: true });
  const { classification } = req.query;
  if (classification && ['hot', 'warm', 'cold'].includes(classification)) {
    serialized.leads = serialized.leads.filter((l) => l.classification === classification);
  }
  res.json(serialized);
});

// PATCH /api/customer/:customerId — edit a customer's profile
app.patch('/api/customer/:customerId', (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const { name, description, icpSize, icpBudget, qualifyingQuestions } = req.body || {};
  if (name !== undefined && !name) {
    return res.status(400).json({ error: 'name cannot be empty.' });
  }
  if (description !== undefined && !description) {
    return res.status(400).json({ error: 'description cannot be empty.' });
  }

  const updated = store.updateCustomer(customer.id, {
    name,
    description,
    icpSize,
    icpBudget,
    qualifyingQuestions: qualifyingQuestions !== undefined ? parseQualifyingQuestions(qualifyingQuestions) : undefined,
  });

  res.json(serializeCustomer(updated));
});

// DELETE /api/customer/:customerId — remove a customer and its lead history
app.delete('/api/customer/:customerId', (req, res) => {
  const deleted = store.deleteCustomer(req.params.customerId);
  if (!deleted) {
    return res.status(404).json({ error: 'Customer not found.' });
  }
  res.status(204).send();
});

// GET /api/customer/:customerId/leads/export — download the lead log as CSV
app.get('/api/customer/:customerId/leads/export', (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  let leads = customer.leads;
  const { classification } = req.query;
  if (classification && ['hot', 'warm', 'cold'].includes(classification)) {
    leads = leads.filter((l) => l.classification === classification);
  }

  const filename = `${customer.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-leads.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(leadsToCsv(leads));
});

// GET /api/plans — the pricing tiers available to purchase
app.get('/api/plans', (req, res) => {
  res.json({ plans: PLANS, billingDemoMode: billing.BILLING_DEMO_MODE });
});

// GET /api/prospects — researched sales prospects (real companies matching the
// ICP). Populated by `npm run find-prospects`; falls back to the bundled,
// manually-verified seed list if that script hasn't been run yet.
app.get('/api/prospects', (req, res) => {
  res.json({ prospects: prospectStore.listProspects() });
});

// GET /api/prospects/export — download the prospect list as CSV
app.get('/api/prospects/export', (req, res) => {
  const prospects = prospectStore.listProspects();
  const header = ['Name', 'Website', 'City', 'Team Size', 'Specialty', 'Phone', 'Email', 'Source', 'Verified At'];
  const rows = prospects.map((p) => [
    p.name, p.website, p.city, p.teamSizeNote, p.specialty, p.phone, p.email, p.source, p.verifiedAt,
  ].map(csvEscape).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects.csv"');
  res.send([header.join(','), ...rows].join('\n'));
});

// POST /api/checkout — buy a plan: provisions the customer record, then starts
// a Stripe Checkout session (or activates instantly in billing demo mode).
app.post('/api/checkout', async (req, res) => {
  const { planId, name, description, icpSize, icpBudget, qualifyingQuestions } = req.body || {};

  const plan = getPlan(planId);
  if (!plan) {
    return res.status(400).json({ error: `Invalid planId. Must be one of: ${PLANS.map((p) => p.id).join(', ')}` });
  }
  if (!name || !description) {
    return res.status(400).json({ error: 'name and description are required.' });
  }

  const customer = store.createCustomer({
    name,
    description,
    icpSize: icpSize || 'Not specified',
    icpBudget: icpBudget || 'Not specified',
    qualifyingQuestions: parseQualifyingQuestions(qualifyingQuestions),
  });
  store.setCustomerPlan(customer.id, plan.id, billing.BILLING_DEMO_MODE ? 'active' : 'pending_payment');

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    const { url, demoMode } = await billing.createCheckoutSession({ plan, customerId: customer.id, baseUrl });
    res.json({ url, demoMode, customerId: customer.id });
  } catch (err) {
    console.error(`[checkout] failed to create session for ${customer.id}:`, err.message);
    res.status(502).json({ error: 'Failed to start checkout.', details: err.message });
  }
});

// GET /checkout/success — lands here after payment (or instantly in demo mode)
app.get('/checkout/success', async (req, res) => {
  const { demo, customerId, session_id: sessionId } = req.query;

  let customer;
  if (demo === 'true') {
    customer = store.getCustomer(customerId);
  } else if (sessionId) {
    try {
      const session = await billing.retrieveSession(sessionId);
      customer = store.getCustomer(session.client_reference_id);
      if (customer && (session.payment_status === 'paid' || session.status === 'complete')) {
        store.setCustomerPlan(customer.id, customer.planId, 'active');
        store.setStripeIds(customer.id, {
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
      }
    } catch (err) {
      return res.status(400).send(`Could not verify checkout session: ${err.message}`);
    }
  }

  if (!customer) {
    return res.status(404).send('Customer not found for this checkout session.');
  }

  const plan = getPlan(customer.planId);
  res.send(successPageHtml({
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook/${customer.id}`,
    planName: plan ? plan.name : undefined,
  }));
});

// GET /checkout/cancel — user backed out of Stripe Checkout
app.get('/checkout/cancel', (req, res) => {
  res.send('<p style="font-family: sans-serif; text-align: center; margin-top: 4rem;">Checkout canceled — no charge was made. <a href="/">Back to LeadQualify AI</a></p>');
});

// POST /webhook/:customerId — receive and classify a lead
app.post('/webhook/:customerId', async (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const message = req.body && (req.body.message || req.body.text);
  if (!message) {
    return res.status(400).json({ error: 'A "message" field with the lead\'s text is required.' });
  }

  try {
    const classification = await classifyLead(customer, message);
    const lead = store.recordLead(customer.id, classification, message);
    res.json({
      classification: lead.classification,
      confidence: lead.confidence,
      response_text: lead.responseText,
      lead,
    });
  } catch (err) {
    console.error(`[webhook:${customer.id}] classification failed:`, err.message);
    res.status(502).json({ error: 'Lead classification failed.', details: err.message });
  }
});

// POST /api/customer/:customerId/test — in-browser test classification (not logged to stats)
app.post('/api/customer/:customerId/test', async (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const message = req.body && req.body.message;
  if (!message) {
    return res.status(400).json({ error: 'A "message" field is required.' });
  }

  try {
    const classification = await classifyLead(customer, message);
    res.json(classification);
  } catch (err) {
    console.error(`[test:${customer.id}] classification failed:`, err.message);
    res.status(502).json({ error: 'Test classification failed.', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LeadQualify AI running at http://localhost:${PORT}`);
});

require('dotenv').config();
const express = require('express');
const path = require('path');

const store = require('./lib/store');
const { classifyLead, MODEL, DEMO_MODE } = require('./lib/claudeService');

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
  // Growth is the target plan the original pricing model is built around ($4,500/mo,
  // $54k/year LTV). Starter is the low-friction entry point; Enterprise (10x Growth)
  // is for agency networks/holding companies running many brands through one account.
  pricingTiers: [
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
  ],
};

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
  };
  if (includeLeads) {
    serialized.leads = customer.leads;
  }
  return serialized;
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

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
  priceMonthly: 4500,
  priceFormatted: '$4,500/month',
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

// GET /api/customers — list all customers (for the dashboard's customer list)
app.get('/api/customers', (req, res) => {
  res.json(store.listCustomers().map((c) => serializeCustomer(c)));
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

// GET /api/customer/:customerId/stats — one customer's stats + lead log
app.get('/api/customer/:customerId/stats', (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }
  res.json(serializeCustomer(customer, { includeLeads: true }));
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

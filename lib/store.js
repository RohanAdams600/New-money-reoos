const crypto = require('crypto');

// In-memory storage. Swap for a real database (Postgres, Mongo, etc.) in production —
// this data disappears whenever the process restarts.
const customers = new Map();

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createCustomer({ name, description, icpSize, icpBudget, qualifyingQuestions }) {
  const id = generateId('cust');
  const customer = {
    id,
    name,
    description,
    icpSize,
    icpBudget,
    qualifyingQuestions,
    createdAt: new Date().toISOString(),
    leads: [],
    stats: { hot: 0, warm: 0, cold: 0, total: 0 },
  };
  customers.set(id, customer);
  return customer;
}

function getCustomer(id) {
  return customers.get(id);
}

function listCustomers() {
  return Array.from(customers.values());
}

function updateCustomer(id, updates) {
  const customer = customers.get(id);
  if (!customer) return null;

  const editable = ['name', 'description', 'icpSize', 'icpBudget', 'qualifyingQuestions'];
  for (const field of editable) {
    if (updates[field] !== undefined) {
      customer[field] = updates[field];
    }
  }
  return customer;
}

function deleteCustomer(id) {
  return customers.delete(id);
}

function recordLead(customerId, classification, rawMessage) {
  const customer = customers.get(customerId);
  if (!customer) return null;

  const lead = {
    id: generateId('lead'),
    receivedAt: new Date().toISOString(),
    rawMessage,
    classification: classification.classification,
    confidence: classification.confidence,
    companyName: classification.company_name,
    problem: classification.problem,
    budget: classification.budget,
    responseText: classification.response_text,
  };

  customer.leads.unshift(lead);
  customer.stats.total += 1;
  if (customer.stats[lead.classification] !== undefined) {
    customer.stats[lead.classification] += 1;
  }

  return lead;
}

function getAggregateStats() {
  const all = listCustomers();
  return all.reduce(
    (acc, c) => ({
      activeCustomers: acc.activeCustomers + 1,
      totalLeads: acc.totalLeads + c.stats.total,
      hot: acc.hot + c.stats.hot,
      warm: acc.warm + c.stats.warm,
      cold: acc.cold + c.stats.cold,
    }),
    { activeCustomers: 0, totalLeads: 0, hot: 0, warm: 0, cold: 0 }
  );
}

module.exports = {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  deleteCustomer,
  recordLead,
  getAggregateStats,
};

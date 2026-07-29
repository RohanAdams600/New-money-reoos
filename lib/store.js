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
    // Billing state — set by the checkout flow, not by the plain admin "add customer" form.
    planId: null,
    billingStatus: 'no_plan', // no_plan | pending_payment | active | canceled
    stripeCustomerId: null,
    stripeSubscriptionId: null,
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

function setCustomerPlan(id, planId, billingStatus) {
  const customer = customers.get(id);
  if (!customer) return null;
  customer.planId = planId;
  customer.billingStatus = billingStatus;
  return customer;
}

function setStripeIds(id, { stripeCustomerId, stripeSubscriptionId } = {}) {
  const customer = customers.get(id);
  if (!customer) return null;
  if (stripeCustomerId !== undefined) customer.stripeCustomerId = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) customer.stripeSubscriptionId = stripeSubscriptionId;
  return customer;
}

function findCustomerByStripeSubscription(stripeSubscriptionId) {
  return listCustomers().find((c) => c.stripeSubscriptionId === stripeSubscriptionId) || null;
}

function recordLead(customerId, classification, rawMessage, { source = 'webhook', from = null } = {}) {
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
    source, // 'webhook' | 'email' — which channel Jarvis captured this lead through
    from,   // sender address, when captured via the inbox/email channel
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
  setCustomerPlan,
  setStripeIds,
  findCustomerByStripeSubscription,
  recordLead,
  getAggregateStats,
};

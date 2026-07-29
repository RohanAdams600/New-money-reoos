const crypto = require('crypto');

// In-memory storage. Swap for a real database (Postgres, Mongo, etc.) once this
// needs to survive restarts — right now everything here disappears on process exit.
const customers = new Map();

// Fixed ID for Night Desk's own "customer" record — the profile Jarvis uses to
// qualify inbound business inquiries that land in Rohan's Gmail (as opposed to
// leads belonging to one of the customer agents Jarvis has built). Fixed rather
// than generated so the Gmail poller always knows where to log against, even
// across restarts.
const NIGHT_DESK_ID = 'nightdesk';

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createCustomer({ id, name, description, icpSize, icpBudget, qualifyingQuestions, internal = false }) {
  const customerId = id || generateId('cust');
  const customer = {
    id: customerId,
    name,
    description,
    icpSize,
    icpBudget,
    qualifyingQuestions,
    createdAt: new Date().toISOString(),
    leads: [],
    stats: { hot: 0, warm: 0, cold: 0, total: 0 },
    // True only for the Night Desk record itself — hidden from the "agents I've
    // built for customers" list so it doesn't look like a customer of its own.
    internal,
  };
  customers.set(customerId, customer);
  return customer;
}

function getCustomer(id) {
  return customers.get(id);
}

// Every customer agent Jarvis has built, excluding Night Desk's own internal record.
function listCustomers() {
  return Array.from(customers.values()).filter((c) => !c.internal);
}

function getOrCreateNightDesk(defaults) {
  return customers.get(NIGHT_DESK_ID) || createCustomer({ id: NIGHT_DESK_ID, internal: true, ...defaults });
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
  if (id === NIGHT_DESK_ID) return false; // Night Desk's own record isn't deletable from the UI
  return customers.delete(id);
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
  NIGHT_DESK_ID,
  createCustomer,
  getCustomer,
  listCustomers,
  getOrCreateNightDesk,
  updateCustomer,
  deleteCustomer,
  recordLead,
  getAggregateStats,
};

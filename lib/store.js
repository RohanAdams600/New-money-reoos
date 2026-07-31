const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Disk-backed storage. Everything lives in memory for fast reads and is
// mirrored to a single JSON file so leads, customers, and stats survive a
// restart — without which the dashboard would reset to zeros every deploy.
// Swap for a real database (Postgres, Mongo, etc.) when concurrent writers
// or multi-instance hosting enter the picture; a single-process Node app
// writing one file is fine until then.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'nightdesk.json');

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

// --- persistence -----------------------------------------------------------

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const customer of parsed.customers || []) {
      customers.set(customer.id, customer);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[store] could not read ${DATA_FILE} (${err.message}) — starting empty.`);
    }
  }
}

let saveTimer = null;

// Writes to a temp file then renames, so a crash mid-write can't leave a
// truncated JSON file behind that would fail to parse on next boot.
function saveNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ customers: Array.from(customers.values()) }, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error(`[store] failed to persist to ${DATA_FILE}:`, err.message);
  }
}

// Debounced so a burst of writes (e.g. a Gmail poll capturing several leads)
// results in one file write rather than one per lead.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 250);
  if (saveTimer.unref) saveTimer.unref(); // never hold the process open just to save
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

load();
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

// --- customers -------------------------------------------------------------

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
  scheduleSave();
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
  scheduleSave();
  return customer;
}

function deleteCustomer(id) {
  if (id === NIGHT_DESK_ID) return false; // Night Desk's own record isn't deletable from the UI
  const deleted = customers.delete(id);
  if (deleted) scheduleSave();
  return deleted;
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

  scheduleSave();
  return lead;
}

// --- stats -----------------------------------------------------------------

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

const EMPTY_STATS = { hot: 0, warm: 0, cold: 0, total: 0 };

// Everything the HUD needs in one call. Deliberately separates Night Desk's OWN
// inbound pipeline (leads from Rohan's Gmail, logged against the internal
// record) from the customer agents' pipelines — getAggregateStats above
// excludes the internal record entirely, so on its own it would report zero
// even when Jarvis had captured real inbound business.
function getDashboardStats() {
  const nightDesk = customers.get(NIGHT_DESK_ID);
  const agents = listCustomers();

  const own = nightDesk ? nightDesk.stats : EMPTY_STATS;
  const clients = agents.reduce(
    (acc, c) => ({
      hot: acc.hot + c.stats.hot,
      warm: acc.warm + c.stats.warm,
      cold: acc.cold + c.stats.cold,
      total: acc.total + c.stats.total,
    }),
    { ...EMPTY_STATS }
  );

  const recentLeads = Array.from(customers.values())
    .flatMap((c) => c.leads.map((l) => ({ ...l, customerId: c.id, customerName: c.name })))
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, 12);

  return {
    own,
    clients,
    combined: {
      hot: own.hot + clients.hot,
      warm: own.warm + clients.warm,
      cold: own.cold + clients.cold,
      total: own.total + clients.total,
    },
    agentCount: agents.length,
    agents: agents.map((c) => ({ id: c.id, name: c.name, stats: c.stats })),
    recentLeads,
  };
}

module.exports = {
  NIGHT_DESK_ID,
  DATA_FILE,
  createCustomer,
  getCustomer,
  listCustomers,
  getOrCreateNightDesk,
  updateCustomer,
  deleteCustomer,
  recordLead,
  getAggregateStats,
  getDashboardStats,
  flush,
};

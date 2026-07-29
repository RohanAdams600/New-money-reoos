// In-memory feed of what Jarvis has been doing. Same "resets on restart" tradeoff
// as lib/store.js — swap for a real datastore alongside it if this needs to persist.

const { narrateCapture } = require('./jarvis');

const MAX_ENTRIES = 200;
const entries = [];

function log(message) {
  entries.unshift({
    id: entries.length + 1,
    at: new Date().toISOString(),
    message,
  });
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
}

function logCapture({ customer, lead, source }) {
  log(
    narrateCapture({
      customerName: customer.name,
      source,
      classification: lead.classification,
      confidence: lead.confidence,
    })
  );
}

function recent(limit = 20) {
  return entries.slice(0, limit);
}

module.exports = { log, logCapture, recent };

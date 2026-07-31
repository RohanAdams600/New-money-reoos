// Feed of what Jarvis has been doing, mirrored to disk alongside lib/store.js so
// the dashboard's activity panel isn't blank after every restart.

const fs = require('fs');
const path = require('path');
const { narrateCapture } = require('./jarvis');

const LOG_FILE = process.env.ACTIVITY_FILE || path.join(__dirname, '..', 'data', 'activity.json');
const MAX_ENTRIES = 200;

let entries = [];
// Monotonic, not derived from entries.length — the array is capped at
// MAX_ENTRIES, so length-based ids would start repeating once it fills up.
let nextId = 1;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    entries = parsed.entries || [];
    nextId = entries.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[activityLog] could not read ${LOG_FILE} (${err.message}) — starting empty.`);
    }
  }
}

let saveTimer = null;

function saveNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const tmp = `${LOG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    fs.renameSync(tmp, LOG_FILE);
  } catch (err) {
    console.error(`[activityLog] failed to persist to ${LOG_FILE}:`, err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 250);
  if (saveTimer.unref) saveTimer.unref();
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

function log(message) {
  entries.unshift({ id: nextId++, at: new Date().toISOString(), message });
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  scheduleSave();
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

module.exports = { log, logCapture, recent, flush, LOG_FILE };

const fs = require('fs');
const path = require('path');
const { SEED_PROSPECTS } = require('../scripts/prospect-seed');

// Read fresh on every call (not cached) so re-running `npm run find-prospects`
// while the server is up is picked up without a restart.
const DATA_FILE = path.join(__dirname, '..', 'public', 'prospects.json');

function listProspects() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Finder script hasn't been run yet in this environment — fall back to the
    // bundled, manually-verified seed list so the dashboard never shows empty.
    return SEED_PROSPECTS;
  }
}

module.exports = { listProspects };

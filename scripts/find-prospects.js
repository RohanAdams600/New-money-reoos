#!/usr/bin/env node
// Finds real prospects (target ICP: digital marketing agencies, 5-25 people) to
// sell LeadQualify AI to. Always starts from a manually-verified seed list (see
// prospect-seed.js — every entry there was checked against the company's own
// live website). Optionally EXTENDS that list with live web search when
// GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX are configured (Google's official
// Custom Search JSON API — not scraping search-engine result pages, which
// would violate their ToS).
//
// Usage:
//   node scripts/find-prospects.js                  # seed data only
//   GOOGLE_SEARCH_API_KEY=... GOOGLE_SEARCH_CX=... node scripts/find-prospects.js
//
// Output: scripts/output/prospects.json and prospects.csv (also copied to
// public/prospects.json so the dashboard's Prospects tab can serve it).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { SEED_PROSPECTS } = require('./prospect-seed');

const OUTPUT_DIR = path.join(__dirname, 'output');
const PUBLIC_COPY = path.join(__dirname, '..', 'public', 'prospects.json');

// Query templates cover a spread of cities and specialties so results aren't
// all clustered around one metro or one service line.
const CITIES = ['Austin TX', 'Denver CO', 'Nashville TN', 'Raleigh NC', 'Phoenix AZ', 'Portland OR'];
const KEYWORDS = ['boutique digital marketing agency', 'small SEO agency', 'PPC agency small team'];

const REQUEST_DELAY_MS = 750; // polite pacing between outbound requests
const USER_AGENT = 'LeadQualifyAI-ProspectFinder/1.0 (+mailto:rohanadams352@gmail.com; researching B2B prospects, low request volume)';
const MAX_LIVE_CANDIDATES = 20; // cap per run so this never behaves like a crawler

const SKIP_DOMAINS = new Set([
  'clutch.co', 'designrush.com', 'upcity.com', 'g2.com', 'yelp.com',
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'youtube.com', 'wikipedia.org', 'crunchbase.com', 'glassdoor.com', 'indeed.com',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(prospects) {
  const header = ['Name', 'Website', 'City', 'Team Size', 'Specialty', 'Phone', 'Email', 'Source', 'Verified At'];
  const rows = prospects.map((p) => [
    p.name, p.website, p.city, p.teamSizeNote, p.specialty, p.phone, p.email, p.source, p.verifiedAt,
  ].map(csvEscape).join(','));
  return [header.join(','), ...rows].join('\n');
}

// Minimal, best-effort robots.txt check — not a full parser, but enough to
// honor an explicit blanket disallow before we fetch a page.
async function isDisallowedByRobots(origin) {
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return false;
    const text = await res.text();
    const lines = text.split('\n').map((l) => l.trim());
    let applies = false;
    for (const line of lines) {
      const [key, value] = line.split(':').map((s) => s && s.trim());
      if (/^user-agent$/i.test(key)) {
        applies = value === '*';
      } else if (applies && /^disallow$/i.test(key) && value === '/') {
        return true;
      }
    }
    return false;
  } catch {
    return false; // if robots.txt is unreachable, don't block on it
  }
}

async function googleSearch(query, apiKey, cx) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Custom Search request failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.items || [];
}

async function extractCompanyInfo(pageUrl) {
  const res = await fetch(pageUrl, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) return null;
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const phoneMatch = html.match(/tel:([+0-9().\-\s]{7,20})/);

  return {
    name: titleMatch ? titleMatch[1].split(/[|\-–]/)[0].trim() : domainOf(pageUrl),
    specialty: descMatch ? descMatch[1].trim().slice(0, 200) : null,
    email: emailMatch ? emailMatch[1] : null,
    phone: phoneMatch ? phoneMatch[1].trim() : null,
  };
}

async function findLiveProspects({ apiKey, cx }) {
  const found = [];
  const seenDomains = new Set();
  const queries = [];
  for (const city of CITIES) {
    for (const keyword of KEYWORDS) {
      queries.push(`${keyword} ${city}`);
    }
  }

  outer:
  for (const query of queries) {
    let items;
    try {
      items = await googleSearch(query, apiKey, cx);
    } catch (err) {
      console.error(`  ! search failed for "${query}": ${err.message}`);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    for (const item of items) {
      if (found.length >= MAX_LIVE_CANDIDATES) break outer;

      const domain = domainOf(item.link);
      if (!domain || seenDomains.has(domain) || SKIP_DOMAINS.has(domain)) continue;
      seenDomains.add(domain);

      const origin = new URL(item.link).origin;
      if (await isDisallowedByRobots(origin)) {
        console.log(`  - skipping ${domain} (robots.txt disallows crawling)`);
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      let info;
      try {
        info = await extractCompanyInfo(item.link);
      } catch (err) {
        console.log(`  - skipping ${domain} (fetch failed: ${err.message})`);
        continue;
      }
      if (!info) continue;

      found.push({
        name: info.name || item.title || domain,
        website: item.link,
        city: 'Unknown — verify manually',
        teamSizeNote: 'Not verified — confirm before outreach',
        specialty: info.specialty || item.snippet || 'Not extracted',
        phone: info.phone,
        email: info.email,
        source: `Live search: "${query}"`,
        verifiedAt: new Date().toISOString().slice(0, 10),
      });
      console.log(`  + found ${info.name || domain} (${domain})`);
    }
  }

  return found;
}

function dedupeByDomain(prospects) {
  const seen = new Set();
  const result = [];
  for (const p of prospects) {
    const domain = domainOf(p.website);
    if (domain && seen.has(domain)) continue;
    if (domain) seen.add(domain);
    result.push(p);
  }
  return result;
}

async function main() {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  const liveModeAvailable = !!(apiKey && cx);

  console.log(`Starting from ${SEED_PROSPECTS.length} manually-verified seed prospects.`);

  let all = [...SEED_PROSPECTS];

  if (liveModeAvailable) {
    console.log('GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX detected — searching live for more prospects...');
    const live = await findLiveProspects({ apiKey, cx });
    console.log(`Live search added ${live.length} candidate(s).`);
    all = all.concat(live);
  } else {
    console.log('No GOOGLE_SEARCH_API_KEY/GOOGLE_SEARCH_CX set — skipping live search.');
    console.log('Get a free Custom Search Engine + API key at https://programmablesearchengine.google.com/ to enable it.');
  }

  const deduped = dedupeByDomain(all);
  console.log(`\nTotal unique prospects: ${deduped.length} (${all.length - deduped.length} duplicate(s) removed)`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'prospects.json'), JSON.stringify(deduped, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'prospects.csv'), toCsv(deduped));
  fs.writeFileSync(PUBLIC_COPY, JSON.stringify(deduped, null, 2));

  console.log(`\nWrote scripts/output/prospects.json`);
  console.log(`Wrote scripts/output/prospects.csv`);
  console.log(`Wrote public/prospects.json (served by the dashboard's Prospects tab)`);
}

main().catch((err) => {
  console.error('find-prospects failed:', err);
  process.exit(1);
});

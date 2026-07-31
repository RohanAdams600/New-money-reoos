require('dotenv').config();
const express = require('express');
const path = require('path');

const store = require('./lib/store');
const { classifyLead, draftAgentConfig, MODEL, DEMO_MODE } = require('./lib/claudeService');
const { JARVIS } = require('./lib/jarvis');
const activityLog = require('./lib/activityLog');
const gmailService = require('./lib/gmailService');
const voiceService = require('./lib/voiceService');
const hudBrain = require('./lib/hudBrain');
const taskStore = require('./lib/tasks');

const app = express();
const PORT = process.env.PORT || 3000;

// Static copy about Night Desk itself, shown on the dashboard.
const NIGHT_DESK_INFO = {
  name: 'Night Desk',
  email: 'rohanadams352@gmail.com',
  description:
    'Night Desk builds and runs AI agents — like Jarvis — that handle lead intake and ' +
    'qualification for other businesses, so no inbound lead ever sits unanswered.',
  targetCustomer: 'Small-to-midsize businesses and agencies with inbound leads and no dedicated intake team',
  painPoint: 'Leads go cold waiting on a reply, and nobody has time to qualify every inbound message by hand',
};

// Night Desk's own "customer" record — the profile Jarvis uses to classify
// business inquiries that land in Rohan's Gmail. Seeded once at boot; editable
// afterward via PATCH /api/customer/nightdesk like any other agent profile.
const NIGHT_DESK_PROFILE_DEFAULTS = {
  name: NIGHT_DESK_INFO.name,
  description: NIGHT_DESK_INFO.description,
  icpSize: 'Any size business with inbound leads and no dedicated intake team',
  icpBudget: 'Open — Jarvis flags interest, budget gets discussed on a call',
  qualifyingQuestions: [
    "What's generating your leads today — website, ads, referrals?",
    'How are leads currently followed up on, and by whom?',
    "What's your timeline for getting this automated?",
  ],
};
store.getOrCreateNightDesk(NIGHT_DESK_PROFILE_DEFAULTS);

app.use(express.json());
// Inbound email parse services (Mailgun/SendGrid-style) post form-encoded bodies,
// not JSON — needed for the /inbox capture channel below.
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// LiveKit's browser SDK, served from node_modules so the HUD has no external
// CDN dependency. Loaded lazily by hud.js only when voice is actually used.
app.use('/vendor/livekit', express.static(path.join(__dirname, 'node_modules', 'livekit-client', 'dist')));

function baseUrlFor(req) {
  return `${req.protocol}://${req.get('host')}`;
}

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
    inboxUrl: `/inbox/${customer.id}`,
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

// Which classifications automatically become a follow-up task. Hot only by
// default: a hot lead going unactioned is the expensive failure, while turning
// every warm lead into a task would bury the real ones. Set AUTO_TASK_FOR to
// "hot,warm" to widen it, or "none" to turn it off.
const AUTO_TASK_FOR = (process.env.AUTO_TASK_FOR ?? 'hot')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s && s !== 'none');

// Single path for every captured lead — webhook, inbox, and the Gmail poller —
// so logging and task creation can't drift apart between channels.
function captureLead({ customer, classification, message, source, from = null }) {
  const lead = store.recordLead(customer.id, classification, message, { source, from });
  activityLog.logCapture({ customer, lead, source });

  if (AUTO_TASK_FOR.includes(lead.classification)) {
    const task = taskStore.createTaskForLead({ lead, customer });
    if (task) activityLog.log(`✅ Added a task: ${task.title}`);
  }

  return lead;
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function leadsToCsv(leads) {
  const header = ['Received At', 'Source', 'From', 'Classification', 'Confidence', 'Company', 'Problem', 'Budget', 'Raw Message', 'Response Sent'];
  const rows = leads.map((l) => [
    l.receivedAt,
    l.source || 'webhook',
    l.from || '',
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

// Runs one Gmail poll cycle: reads unread mail under Jarvis's label, classifies
// each against Night Desk's own profile, drafts (or sends) a reply, and marks it
// processed. Shared by the background timer and the manual "Check Inbox Now" button.
let gmailPollState = { lastPollAt: null, lastError: null, lastCount: 0 };

async function pollGmailInbox(baseUrl) {
  if (!gmailService.isConnected()) return gmailPollState;

  try {
    const messages = await gmailService.listLeadMessages(baseUrl);
    const nightDesk = store.getOrCreateNightDesk(NIGHT_DESK_PROFILE_DEFAULTS);

    for (const msg of messages) {
      const text = [msg.subject, msg.body].filter(Boolean).join('\n\n').trim();
      if (!text) {
        await gmailService.markProcessed(baseUrl, msg.id);
        continue;
      }

      const classification = await classifyLead(nightDesk, text);
      captureLead({ customer: nightDesk, classification, message: text, source: 'email', from: msg.from });

      if (gmailService.AUTO_SEND) {
        await gmailService.sendReply(baseUrl, msg, classification.response_text);
        activityLog.log(`📤 Sent a reply to ${msg.from} — auto-send is on.`);
      } else {
        await gmailService.createDraftReply(baseUrl, msg, classification.response_text);
        activityLog.log(`✉️ Drafted a reply to ${msg.from} in Gmail — review and hit send.`);
      }

      await gmailService.markProcessed(baseUrl, msg.id);
    }

    gmailPollState = { lastPollAt: new Date().toISOString(), lastError: null, lastCount: messages.length };
  } catch (err) {
    console.error('[jarvis:gmail-poll] failed:', err.message);
    gmailPollState = { lastPollAt: new Date().toISOString(), lastError: err.message, lastCount: 0 };
  }

  return gmailPollState;
}

const POLL_MINUTES = Math.max(1, parseInt(process.env.GMAIL_POLL_MINUTES, 10) || 5);
if (gmailService.isConfigured()) {
  const pollBaseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  setInterval(() => pollGmailInbox(pollBaseUrl), POLL_MINUTES * 60 * 1000);
}

// GET / — main dashboard
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

// GET /api/business-info — static copy about Night Desk for the dashboard
app.get('/api/business-info', (req, res) => {
  res.json(NIGHT_DESK_INFO);
});

// GET /api/jarvis — Jarvis's identity/persona for the dashboard's "Meet Jarvis" panel
app.get('/api/jarvis', (req, res) => {
  res.json(JARVIS);
});

// GET /api/jarvis/activity — Jarvis's recent activity feed, newest first
app.get('/api/jarvis/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  res.json({ activity: activityLog.recent(limit) });
});

// POST /api/jarvis/draft-agent — Jarvis drafts a starting ICP + qualifying
// questions for a new customer from a one-line description.
app.post('/api/jarvis/draft-agent', async (req, res) => {
  const description = req.body && req.body.description;
  if (!description) {
    return res.status(400).json({ error: 'A "description" field is required.' });
  }

  try {
    const draft = await draftAgentConfig(description);
    res.json(draft);
  } catch (err) {
    console.error('[jarvis:draft-agent] failed:', err.message);
    res.status(502).json({ error: 'Failed to draft agent config.', details: err.message });
  }
});

// GET /api/jarvis/gmail — Jarvis's Gmail connection status
app.get('/api/jarvis/gmail', async (req, res) => {
  const configured = gmailService.isConfigured();
  const connected = gmailService.isConnected();
  let connectedEmail = null;
  if (connected) {
    try {
      connectedEmail = await gmailService.getConnectedEmail(baseUrlFor(req));
    } catch (err) {
      console.error('[jarvis:gmail-status] failed to fetch profile:', err.message);
    }
  }

  res.json({
    configured,
    connected,
    connectedEmail,
    label: gmailService.LABEL_NAME,
    autoSend: gmailService.AUTO_SEND,
    pollMinutes: POLL_MINUTES,
    poll: gmailPollState,
  });
});

// POST /api/jarvis/gmail/check-now — trigger an immediate poll cycle
app.post('/api/jarvis/gmail/check-now', async (req, res) => {
  if (!gmailService.isConnected()) {
    return res.status(400).json({ error: 'Gmail is not connected yet. Visit /auth/google first.' });
  }
  const result = await pollGmailInbox(baseUrlFor(req));
  res.json(result);
});

// GET /auth/google — start the OAuth flow
app.get('/auth/google', (req, res) => {
  if (!gmailService.isConfigured()) {
    return res.status(400).send(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Add them to .env first — see .env.example for setup steps.'
    );
  }
  res.redirect(gmailService.getAuthUrl(baseUrlFor(req)));
});

// GET /auth/google/callback — OAuth redirect target
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`Google OAuth error: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Missing "code" query parameter.');
  }

  try {
    await gmailService.handleOAuthCallback(code, baseUrlFor(req));
    res.redirect('/?gmail=connected');
  } catch (err) {
    console.error('[auth/google/callback] token exchange failed:', err.message);
    res.status(502).send(`Failed to connect Gmail: ${err.message}`);
  }
});

// GET /api/stats — aggregate metrics across every agent Jarvis has built
app.get('/api/stats', (req, res) => {
  res.json(store.getAggregateStats());
});

// --- HUD ---------------------------------------------------------------------

// GET /hud — the glowing heads-up dashboard, built mobile-first for a phone.
app.get('/hud', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hud.html'));
});

// One snapshot of everything the HUD (and Jarvis's voice answers) run on.
function dashboardSnapshot() {
  return {
    ...store.getDashboardStats(),
    activity: activityLog.recent(12),
    tasks: {
      ...taskStore.getTaskStats(),
      open: taskStore.listTasks({ status: 'open' }),
      recentlyDone: taskStore.listTasks({ status: 'done' }).slice(0, 5),
    },
    demoMode: DEMO_MODE,
    gmailConnected: gmailService.isConnected(),
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/dashboard — everything the HUD renders, in one call
app.get('/api/dashboard', (req, res) => {
  res.json(dashboardSnapshot());
});

// POST /api/hud/ask — ask Jarvis a question about the business as text. Same
// brain the voice path uses, so it works (and can be tested) with no mic and
// no voice keys configured at all.
app.post('/api/hud/ask', async (req, res) => {
  const question = req.body && req.body.question;
  if (!question) {
    return res.status(400).json({ error: 'A "question" field is required.' });
  }
  try {
    // handle() acts on commands ("remind me to…") and answers everything else.
    const { reply, action } = await hudBrain.handle(question, dashboardSnapshot());
    if (action) activityLog.log(`🗣️ ${reply}`);
    res.json({ question, reply, action });
  } catch (err) {
    console.error('[hud/ask] failed:', err.message);
    res.status(502).json({ error: 'Could not answer that.', details: err.message });
  }
});

// --- Tasks -------------------------------------------------------------------

// GET /api/tasks — the task list. ?status=open|done to filter.
app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: taskStore.listTasks({ status: req.query.status }),
    stats: taskStore.getTaskStats(),
  });
});

// POST /api/tasks — add a task by hand
app.post('/api/tasks', (req, res) => {
  const { title, notes, priority } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'A "title" field is required.' });
  }
  const task = taskStore.createTask({ title, notes, priority, source: 'manual' });
  activityLog.log(`✅ Added a task: ${task.title}`);
  res.status(201).json(task);
});

// PATCH /api/tasks/:taskId — edit or complete/reopen a task
app.patch('/api/tasks/:taskId', (req, res) => {
  const { title, notes, priority, status } = req.body || {};
  if (status !== undefined && !['open', 'done'].includes(status)) {
    return res.status(400).json({ error: 'status must be "open" or "done".' });
  }

  const task = taskStore.updateTask(req.params.taskId, { title, notes, priority, status });
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  if (status === 'done') activityLog.log(`✅ Completed: ${task.title}`);
  res.json(task);
});

// DELETE /api/tasks/:taskId — remove a task entirely
app.delete('/api/tasks/:taskId', (req, res) => {
  if (!taskStore.deleteTask(req.params.taskId)) {
    return res.status(404).json({ error: 'Task not found.' });
  }
  res.status(204).send();
});

// GET /api/voice/config — which parts of the voice stack are actually wired up
app.get('/api/voice/config', (req, res) => {
  res.json({
    enabled: voiceService.VOICE_ENABLED,
    capabilities: voiceService.capabilities,
    missing: voiceService.missingPieces(),
    livekitUrl: voiceService.VOICE_ENABLED ? voiceService.LIVEKIT_URL : null,
  });
});

// POST /api/voice/token — mint a LiveKit token for the browser and make sure
// Jarvis's agent is in that room waiting. Required before the HUD can talk.
app.post('/api/voice/token', async (req, res) => {
  if (!voiceService.VOICE_ENABLED) {
    return res.status(503).json({
      error: 'Voice is not configured.',
      missing: voiceService.missingPieces(),
    });
  }

  const roomName = (req.body && req.body.room) || 'nightdesk-hud';
  const identity = `rohan-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Required lazily so a missing/broken native LiveKit binary can't stop the
    // whole server from booting — the HUD itself doesn't need it.
    const voiceAgent = require('./lib/voiceAgent');
    const token = await voiceService.createAccessToken({ roomName, identity });
    await voiceAgent.ensureAgent({ roomName, getSnapshot: dashboardSnapshot });
    res.json({ token, url: voiceService.LIVEKIT_URL, room: roomName, identity });
  } catch (err) {
    console.error('[voice/token] failed:', err.message);
    res.status(502).json({ error: 'Could not start the voice session.', details: err.message });
  }
});

// GET /api/customers — list every customer agent, including lead logs
app.get('/api/customers', (req, res) => {
  res.json(store.listCustomers().map((c) => serializeCustomer(c, { includeLeads: true })));
});

// POST /api/customer/create — Jarvis builds a new agent for a customer
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

// GET /api/customer/:customerId/stats — one agent's stats + lead log.
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

// PATCH /api/customer/:customerId — edit an agent's profile (also used for
// Night Desk's own profile at /api/customer/nightdesk)
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

// DELETE /api/customer/:customerId — remove an agent and its lead history
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
    const lead = captureLead({ customer, classification, message, source: 'webhook' });
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

// POST /inbox/:customerId — Jarvis's inbox capture channel. Point an inbound-email
// parse service (Mailgun Routes, SendGrid Inbound Parse) or a Zapier/Make "new
// email" automation at this URL and Jarvis classifies it exactly like a webhook
// lead. Accepts Mailgun's field names (sender/body-plain), SendGrid's (from/text),
// or a plain {from, subject, body} JSON payload.
app.post('/inbox/:customerId', async (req, res) => {
  const customer = store.getCustomer(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found.' });
  }

  const body = req.body || {};
  const from = body.sender || body.from || body.From || null;
  const subject = body.subject || body.Subject || '';
  const text = body['body-plain'] || body['stripped-text'] || body.text || body.body || '';
  const message = [subject, text].filter(Boolean).join('\n\n').trim();

  if (!message) {
    return res.status(400).json({ error: 'No email content found — expected a "text"/"body" (and optional "subject") field.' });
  }

  try {
    const classification = await classifyLead(customer, message);
    const lead = captureLead({ customer, classification, message, source: 'email', from });
    res.json({
      classification: lead.classification,
      confidence: lead.confidence,
      response_text: lead.responseText,
      lead,
    });
  } catch (err) {
    console.error(`[inbox:${customer.id}] classification failed:`, err.message);
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
  console.log(`🤖 Night Desk — Jarvis running at http://localhost:${PORT}`);
});

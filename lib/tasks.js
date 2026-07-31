// Jarvis's task list — the "what do I actually need to do" layer that sits on
// top of lead capture. Tasks come from three places:
//   - Rohan, by voice or typed ("remind me to call the HVAC guy")
//   - Jarvis, automatically, when a hot lead lands and needs a human follow-up
//   - The API, for anything else wired in later
//
// Same disk-backed pattern as lib/store.js: in memory for reads, mirrored to
// JSON with debounced atomic writes so nothing is lost on restart.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TASKS_FILE = process.env.TASKS_FILE || path.join(__dirname, '..', 'data', 'tasks.json');

let tasks = [];

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    tasks = parsed.tasks || [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[tasks] could not read ${TASKS_FILE} (${err.message}) — starting empty.`);
    }
  }
}

let saveTimer = null;

function saveNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    const tmp = `${TASKS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
  } catch (err) {
    console.error(`[tasks] failed to persist to ${TASKS_FILE}:`, err.message);
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

function createTask({ title, notes = '', priority = 'normal', source = 'manual', relatedLeadId = null, relatedCustomerId = null }) {
  const task = {
    id: `task_${crypto.randomBytes(5).toString('hex')}`,
    title: String(title || '').trim(),
    notes,
    priority: priority === 'high' ? 'high' : 'normal',
    status: 'open',
    source, // manual | lead | email
    relatedLeadId,
    relatedCustomerId,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  tasks.unshift(task);
  scheduleSave();
  return task;
}

// Jarvis creating a follow-up for himself when a hot lead lands. Deduplicated on
// the lead id — the same lead must never spawn two identical tasks, which would
// otherwise happen if a capture path ever retried.
function createTaskForLead({ lead, customer }) {
  if (tasks.some((t) => t.relatedLeadId === lead.id)) return null;

  const who = lead.companyName && !/not extracted/i.test(lead.companyName)
    ? lead.companyName
    : (lead.from || customer.name);

  return createTask({
    title: `Follow up with ${who}`,
    notes: `${lead.classification.toUpperCase()} lead (${lead.confidence}% confidence) via ${lead.source} for ${customer.name}. ${lead.problem || ''}`.trim(),
    priority: lead.classification === 'hot' ? 'high' : 'normal',
    source: 'lead',
    relatedLeadId: lead.id,
    relatedCustomerId: customer.id,
  });
}

function listTasks({ status } = {}) {
  if (status === 'open' || status === 'done') {
    return tasks.filter((t) => t.status === status);
  }
  return tasks.slice();
}

function getTask(id) {
  return tasks.find((t) => t.id === id) || null;
}

function updateTask(id, updates) {
  const task = getTask(id);
  if (!task) return null;

  for (const field of ['title', 'notes', 'priority']) {
    if (updates[field] !== undefined) task[field] = updates[field];
  }

  if (updates.status === 'done' || updates.status === 'open') {
    task.status = updates.status;
    task.completedAt = updates.status === 'done' ? new Date().toISOString() : null;
  }

  scheduleSave();
  return task;
}

function completeTask(id) {
  return updateTask(id, { status: 'done' });
}

// Completes by fuzzy title match, for "mark the HVAC one done" said out loud.
// Only ever matches open tasks, and returns null on an ambiguous match rather
// than guessing which of several the user meant.
function completeTaskByPhrase(phrase) {
  const needle = String(phrase || '').toLowerCase().trim();
  if (!needle) return null;

  const open = listTasks({ status: 'open' });
  const matches = open.filter((t) => t.title.toLowerCase().includes(needle));
  if (matches.length !== 1) return null;

  return completeTask(matches[0].id);
}

function deleteTask(id) {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  if (tasks.length === before) return false;
  scheduleSave();
  return true;
}

function getTaskStats() {
  const open = tasks.filter((t) => t.status === 'open');
  return {
    open: open.length,
    done: tasks.filter((t) => t.status === 'done').length,
    highPriorityOpen: open.filter((t) => t.priority === 'high').length,
    total: tasks.length,
  };
}

module.exports = {
  TASKS_FILE,
  createTask,
  createTaskForLead,
  listTasks,
  getTask,
  updateTask,
  completeTask,
  completeTaskByPhrase,
  deleteTask,
  getTaskStats,
  flush,
};

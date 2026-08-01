// The brain behind the HUD's voice/text interface. Two responsibilities:
//
//   1. ACT  — recognise a command ("remind me to call Dave", "mark the HVAC one
//             done") and carry it out against the task list.
//   2. ANSWER — everything else: questions about the live business data.
//
// Intent detection for actions is deliberately rule-based rather than a model
// call. It has to work identically in DEMO_MODE (no API key, no cost), it must
// be predictable — a misfire creates or completes real tasks — and it removes a
// round-trip of latency from the voice path.

const OpenAI = require('openai');
const { DEMO_MODE, MODEL } = require('./claudeService');
const { personaPreamble } = require('./jarvis');
const tasks = require('./tasks');
const { parseSchedulingRequest, formatWhen } = require('./scheduleParser');

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://nightdesk.ai',
        'X-Title': 'Night Desk — Jarvis HUD',
      },
    });
  }
  return client;
}

// --- intent detection ------------------------------------------------------

// Anchored at the start so a question that merely mentions a task ("what tasks
// do I need to do?") can't be mistaken for a command to create one.
const CREATE_PATTERNS = [
  /^(?:remind me to|remember to|note to self,?)\s+(.+)$/i,
  /^(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?task\s*(?:to|:|that says)?\s+(.+)$/i,
  /^task:\s*(.+)$/i,
  /^(?:i need to|i have to|i should)\s+(.+)$/i,
];

const COMPLETE_PATTERNS = [
  // Particle-first phrasings ("check off the invoice") — no trailing
  // "done"/"off" to anchor on, so these need their own pattern.
  /^(?:check|tick|cross|knock)\s+off\s+(?:the\s+)?(.+)$/i,
  /^(?:mark|check off|check|tick off)\s+(?:the\s+)?(.+?)\s*(?:one\s+)?(?:as\s+)?(?:done|complete|completed|finished|off)$/i,
  /^(?:complete|finish|finished|done with)\s+(?:the\s+)?(.+?)(?:\s+task)?$/i,
  /^(?:i\s+)?(?:did|finished)\s+(?:the\s+)?(.+?)(?:\s+task)?$/i,
];

const LIST_PATTERN = /\b(task|to.?do|to do list)/i;

const SCHEDULE_PATTERNS = [
  /^(?:can you\s+|please\s+)?(?:book|schedule|set ?up|arrange|put in|add)\b\s+(.+)$/i,
];

const CALENDAR_QUESTION = /\b(calendar|schedule|agenda|meeting|appointment|booked|coming up|what'?s on)\b/i;

function matchFirst(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
  }
  return null;
}

function stripTrailing(text) {
  return text.replace(/[.!?]+$/, '').trim();
}

function detectIntent(rawInput) {
  const input = stripTrailing(String(rawInput || '').trim());
  if (!input) return { type: 'none' };

  // Questions are never commands, even when they start with a command-ish verb.
  if (/^(what|which|how many|how's|hows|who|when|is there|are there|do i have|show me|tell me)\b/i.test(input)) {
    return { type: 'ask' };
  }

  // Scheduling is checked before task creation because "set up a call with
  // jane@x.com friday at 3" matches both — and when it carries a real date it
  // should become a calendar event, not a to-do item about one.
  const scheduled = matchFirst(SCHEDULE_PATTERNS, input);
  if (scheduled) {
    const parsed = parseSchedulingRequest(input);
    if (parsed) return { type: 'schedule_meeting', details: parsed };
    // Matched "book a…" but with no usable time. Capture it as a task rather
    // than dropping it — "book a call with Dave" is a real intention, and
    // silently answering it as a question would lose it entirely.
    return { type: 'create_task', title: stripTrailing(scheduled) };
  }

  const created = matchFirst(CREATE_PATTERNS, input);
  if (created) return { type: 'create_task', title: stripTrailing(created) };

  const completed = matchFirst(COMPLETE_PATTERNS, input);
  if (completed) return { type: 'complete_task', phrase: stripTrailing(completed) };

  return { type: 'ask' };
}

// --- answering -------------------------------------------------------------

function buildSystemPrompt(snapshot) {
  return `${personaPreamble()}

You're answering Rohan out loud through a heads-up dashboard, so keep replies to
one or two short sentences — this is speech, not a report. Lead with the number
or the answer, then at most one line of context. No preamble, no "great
question", no restating what he asked.

Here is the live state of the business right now. Answer only from this — if the
answer isn't in here, say you don't have that yet rather than guessing:

${JSON.stringify(snapshot, null, 2)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Rule-based answers for the questions actually asked of a lead dashboard.
// Reads the same snapshot the model path gets, so numbers match either way.
function ruleBasedAnswer(question, snapshot) {
  const q = String(question || '').toLowerCase();
  const { own, clients, combined, agentCount, recentLeads, activity, tasks: taskState, calendar } = snapshot;

  if (CALENDAR_QUESTION.test(q) && !LIST_PATTERN.test(q)) {
    const events = (calendar && calendar.upcoming) || [];
    if (calendar && calendar.state && calendar.state !== 'connected') {
      return "Your calendar isn't connected yet — link Google Calendar and I'll read it out.";
    }
    if (!events.length) return 'Nothing on the calendar for the next week.';
    const next = events[0];
    const when = next.start ? formatWhen(new Date(next.start)) : 'soon';
    const more = events.length > 1 ? ` Then ${events.length - 1} more this week.` : '';
    return `Next up: ${next.title}, ${when}.${more}`;
  }

  if (LIST_PATTERN.test(q)) {
    const openTasks = (taskState && taskState.open) || [];
    if (!openTasks.length) return 'Nothing on your list. You’re clear.';
    const top = openTasks.slice(0, 3).map((t) => t.title).join('; ');
    const extra = openTasks.length > 3 ? `, and ${openTasks.length - 3} more` : '';
    return `${plural(openTasks.length, 'open task')}: ${top}${extra}.`;
  }

  if (/\b(hot)\b/.test(q)) {
    return combined.hot === 0
      ? "No hot leads yet. Nothing's come in that's ready to buy."
      : `${plural(combined.hot, 'hot lead')} — ${own.hot} from your own inbox, ${clients.hot} across customer agents.`;
  }

  if (/\bwarm\b/.test(q)) {
    return combined.warm === 0 ? 'No warm leads right now.' : `${plural(combined.warm, 'warm lead')} waiting on a follow-up.`;
  }

  if (/\bcold\b/.test(q)) {
    return `${plural(combined.cold, 'cold lead')} logged and set aside.`;
  }

  if (/(latest|last|recent|newest)\b.*\blead|lead.*\b(latest|last|recent|newest)/.test(q)) {
    const lead = recentLeads && recentLeads[0];
    if (!lead) return "No leads captured yet — nothing's come through the inbox or any webhook.";
    return `Newest is ${lead.classification.toUpperCase()}, ${lead.confidence}% confidence, for ${lead.customerName}${lead.from ? `, from ${lead.from}` : ''}.`;
  }

  if (/\b(agent|customer|client)s?\b/.test(q)) {
    return agentCount === 0
      ? "You haven't built any customer agents yet — it's just Night Desk's own inbox so far."
      : `${plural(agentCount, 'customer agent')} running, ${plural(clients.total, 'lead')} between them.`;
  }

  if (/(what.*(you|jarvis).*(do|been)|activity|happened|update)/.test(q)) {
    const latest = activity && activity[0];
    return latest ? latest.message : "Nothing's happened yet — I'm watching, but it's quiet.";
  }

  if (/(pipeline|status|summary|how.*(doing|look)|overview|brief|briefing)/.test(q)) {
    const openCount = ((taskState && taskState.open) || []).length;
    if (combined.total === 0 && openCount === 0) {
      return "Pipeline's empty and your list is clear. Nothing has come in yet.";
    }
    return `${plural(combined.total, 'lead')} — ${combined.hot} hot, ${combined.warm} warm, ${combined.cold} cold. ${plural(openCount, 'open task')}.`;
  }

  return `I've got ${plural(combined.total, 'lead')}, ${plural(agentCount, 'customer agent')}, and ${plural(((taskState && taskState.open) || []).length, 'open task')}. Ask about leads, your tasks, or what I've been doing — or say "remind me to…" and I'll add it.`;
}

async function answer(question, snapshot) {
  if (DEMO_MODE) {
    return ruleBasedAnswer(question, snapshot);
  }

  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 160,
      // Off for latency — this sits in the live voice path, where every extra
      // hundred milliseconds is audible as a pause before Jarvis answers.
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: buildSystemPrompt(snapshot) },
        { role: 'user', content: question },
      ],
    });
    const text = completion.choices?.[0]?.message?.content;
    return text ? text.trim() : ruleBasedAnswer(question, snapshot);
  } catch (err) {
    console.error('[hudBrain] falling back to rule-based answer:', err.message);
    return ruleBasedAnswer(question, snapshot);
  }
}

// Single entry point for the HUD and the voice agent: acts when the input is a
// command, answers when it's a question. Returns the reply plus what it did, so
// the caller can log the action and refresh the UI.
/**
 * @param {object} [deps.calendar] - { createEvent(details) }. When absent,
 *        scheduling requests are answered with why they can't be actioned
 *        rather than silently becoming tasks — a meeting the user believes is
 *        booked but isn't is worse than a clear refusal.
 */
async function handle(input, snapshot, deps = {}) {
  const intent = detectIntent(input);

  if (intent.type === 'schedule_meeting') {
    const d = intent.details;

    if (!deps.calendar) {
      return {
        reply: `I can't reach your calendar — Google Calendar isn't connected yet. Connect it and I'll book "${d.title}" for ${d.spokenTime}.`,
        action: null,
      };
    }

    try {
      const event = await deps.calendar.createEvent(d);
      // Always read the time back. A misparsed "at 2" is only catchable if the
      // confirmation states what was actually booked.
      const who = d.attendees.length ? ` with ${d.attendees.join(', ')}` : '';
      const invite = d.attendees.length
        ? (event.invitesSent ? ' Invite sent.' : ' Invite is ready — confirm to send it.')
        : '';
      const check = d.ambiguousMeridiem ? ' (read that as the afternoon — say so if you meant morning.)' : '';
      return {
        reply: `Booked "${event.title}"${who} for ${d.spokenTime}.${invite}${check}`,
        action: { type: 'event_created', event },
      };
    } catch (err) {
      return { reply: `Couldn't book that: ${err.message}`, action: null };
    }
  }

  if (intent.type === 'create_task') {
    const task = tasks.createTask({ title: intent.title, source: 'manual' });
    return { reply: `Added: ${task.title}.`, action: { type: 'task_created', task } };
  }

  if (intent.type === 'complete_task') {
    const done = tasks.completeTaskByPhrase(intent.phrase);
    if (done) {
      return { reply: `Done: ${done.title}.`, action: { type: 'task_completed', task: done } };
    }
    const open = tasks.listTasks({ status: 'open' });
    const matches = open.filter((t) => t.title.toLowerCase().includes(intent.phrase.toLowerCase()));
    const reply = matches.length > 1
      ? `That matches ${matches.length} tasks — be more specific.`
      : `Nothing open matching "${intent.phrase}".`;
    return { reply, action: null };
  }

  return { reply: await answer(input, snapshot), action: null };
}

module.exports = { handle, answer, ruleBasedAnswer, detectIntent };

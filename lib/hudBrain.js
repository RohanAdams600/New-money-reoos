// The brain behind the HUD's voice/text Q&A. Takes a question plus a live
// snapshot of the real business data and answers it in Jarvis's voice.
//
// Two paths, same contract:
//   - With a real OPENROUTER_API_KEY, Claude answers with the snapshot as context.
//   - Without one, a rule-based responder handles the common questions from the
//     same snapshot. Not as flexible, but it's real data and it's free — same
//     DEMO_MODE tradeoff as mockClassifier.js.

const OpenAI = require('openai');
const { DEMO_MODE, MODEL } = require('./claudeService');
const { personaPreamble } = require('./jarvis');

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

// Rule-based answers for the questions that actually get asked of a lead
// dashboard. Reads the same snapshot the LLM path gets, so the numbers are
// identical either way.
function ruleBasedAnswer(question, snapshot) {
  const q = String(question || '').toLowerCase();
  const { own, clients, combined, agentCount, recentLeads, activity } = snapshot;

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

  if (/(pipeline|status|summary|how.*(doing|look)|overview|brief)/.test(q)) {
    if (combined.total === 0) {
      return "Pipeline's empty. Nothing has come in through the inbox or any webhook yet.";
    }
    return `${plural(combined.total, 'lead')} total — ${combined.hot} hot, ${combined.warm} warm, ${combined.cold} cold, across ${plural(agentCount, 'agent')}.`;
  }

  return `I've got ${plural(combined.total, 'lead')} and ${plural(agentCount, 'customer agent')} on file. Ask me about hot, warm, or cold leads, your latest lead, or what I've been doing.`;
}

async function answer(question, snapshot) {
  if (DEMO_MODE) {
    return ruleBasedAnswer(question, snapshot);
  }

  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 160,
      // Off for latency — this sits in the live voice path, where every
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

module.exports = { answer, ruleBasedAnswer };

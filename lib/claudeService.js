const OpenAI = require('openai');
const { mockClassifyLead } = require('./mockClassifier');
const { personaPreamble } = require('./jarvis');

// Claude Opus 5, called through OpenRouter (https://openrouter.ai) rather than
// Anthropic directly — OpenRouter exposes it via an OpenAI-compatible API.
const MODEL = 'anthropic/claude-opus-5';
const MAX_TOKENS = 600;

function looksLikeRealApiKey(key) {
  return typeof key === 'string' && /^sk-or-v1-[a-f0-9]{20,}$/.test(key) && !/replace/i.test(key);
}

// Demo mode runs a free, rule-based classifier instead of calling Claude — no API key,
// no cost. It kicks in automatically when there's no valid-looking key, or explicitly
// via DEMO_MODE=true even when a real key is present.
const DEMO_MODE = process.env.DEMO_MODE === 'true' || !looksLikeRealApiKey(process.env.OPENROUTER_API_KEY);

if (DEMO_MODE) {
  console.warn('⚠️  Running in DEMO MODE — using a free rule-based classifier, not Claude. Add a real OPENROUTER_API_KEY to .env (with credits) to use the real thing.');
}

// Only constructed when actually needed so demo mode never touches the SDK.
let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://leadqualify.ai',
        'X-Title': 'LeadQualify AI',
      },
    });
  }
  return client;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: ['hot', 'warm', 'cold'] },
    confidence: { type: 'integer' },
    company_name: { type: 'string' },
    problem: { type: 'string' },
    budget: { type: 'string' },
    response_text: { type: 'string' },
  },
  required: ['classification', 'confidence', 'company_name', 'problem', 'budget', 'response_text'],
  additionalProperties: false,
};

function buildSystemPrompt(customer) {
  const questions = (customer.qualifyingQuestions || [])
    .map((q, i) => `${i + 1}. ${q}`)
    .join('\n');

  return `${personaPreamble()}

Right now you're handling intake for ${customer.name}, a company described as: "${customer.description}"

Your job, given an inbound lead message:
1. Extract key info: company name, company size, the problem they describe, and any budget signal.
2. Naturally work in ONE qualifying question chosen from the list below, based on whatever information is missing from their message — don't ask something they already told you.
${questions || '(No qualifying questions configured for this customer.)'}
3. Classify the lead:
   - "hot": clear budget signal + decision maker + timeline present = ready to buy
   - "warm": interested but missing 1-2 key signals (budget or timeline)
   - "cold": wrong industry/size, no budget signal, or a completely different problem
4. This company's ideal customer profile is: ${customer.icpSize} company size, ${customer.icpBudget} annual budget. Weigh how well the lead matches this profile.
5. Give a confidence score from 0-100 for your classification.

Sound like a human, not a bot. Keep response_text to 2-3 sentences — that's the reply that will be sent back to the lead.`;
}

async function classifyLead(customer, leadMessage) {
  if (DEMO_MODE) {
    return mockClassifyLead(customer, leadMessage);
  }

  let completion;
  try {
    completion = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Disabled for latency — this runs in the real-time webhook path.
      reasoning: { enabled: false },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'lead_classification', strict: true, schema: RESPONSE_SCHEMA },
      },
      messages: [
        { role: 'system', content: buildSystemPrompt(customer) },
        { role: 'user', content: leadMessage },
      ],
    });
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      throw new Error('Invalid OPENROUTER_API_KEY.');
    }
    if (err?.status === 402) {
      throw new Error('OpenRouter account has insufficient credits. Add credits at https://openrouter.ai/settings/credits.');
    }
    if (err instanceof OpenAI.RateLimitError) {
      throw new Error('Rate limited by OpenRouter. Retry shortly.');
    }
    throw new Error(err.message || 'OpenRouter request failed.');
  }

  const choice = completion.choices && completion.choices[0];
  if (!choice) {
    throw new Error('OpenRouter returned no completion choices.');
  }

  // OpenRouter surfaces the underlying provider's real stop reason here.
  if (choice.native_finish_reason === 'refusal') {
    throw new Error('Claude declined to process this lead message.');
  }

  const content = choice.message && choice.message.content;
  if (!content) {
    throw new Error('OpenRouter returned no classification content.');
  }

  return JSON.parse(content);
}

module.exports = { classifyLead, MODEL, DEMO_MODE };

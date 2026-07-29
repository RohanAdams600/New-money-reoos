const Anthropic = require('@anthropic-ai/sdk');

// Claude Opus 5 — current flagship model, successor to the claude-opus-4-6 line.
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 600;

// Reads ANTHROPIC_API_KEY from the environment automatically.
const client = new Anthropic();

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

  return `You are a lead qualification specialist for ${customer.name}, a company described as: "${customer.description}"

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
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Disabled for latency — this runs in the real-time webhook path.
    thinking: { type: 'disabled' },
    system: buildSystemPrompt(customer),
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: 'user', content: leadMessage }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this lead message.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('Claude returned no classification content.');
  }

  return JSON.parse(textBlock.text);
}

module.exports = { classifyLead, MODEL };

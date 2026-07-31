// Configuration + capability detection for the voice stack:
//   LiveKit    — WebRTC transport carrying mic audio in and Jarvis's voice out
//   Deepgram   — speech-to-text on the inbound audio
//   ElevenLabs — text-to-speech for Jarvis's replies
//
// Every piece is optional. With no keys the HUD still works completely — it
// just can't talk. Same pattern as DEMO_MODE in claudeService.js: degrade to
// something usable rather than crashing on a missing key.

const { AccessToken } = require('livekit-server-sdk');

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// Adam — a deep, calm default. Override with any voice ID from your ElevenLabs
// voice library via ELEVENLABS_VOICE_ID.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';

function looksSet(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE|YOUR_|PUT_YOUR/i.test(value);
}

const capabilities = {
  livekit: looksSet(LIVEKIT_URL) && looksSet(LIVEKIT_API_KEY) && looksSet(LIVEKIT_API_SECRET),
  deepgram: looksSet(DEEPGRAM_API_KEY),
  elevenlabs: looksSet(ELEVENLABS_API_KEY),
};

// Voice needs all three: transport, ears, and a mouth. Missing any one of them
// means there's no complete path from "user speaks" to "Jarvis answers aloud".
const VOICE_ENABLED = capabilities.livekit && capabilities.deepgram && capabilities.elevenlabs;

function missingPieces() {
  const missing = [];
  if (!capabilities.livekit) missing.push('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  if (!capabilities.deepgram) missing.push('DEEPGRAM_API_KEY');
  if (!capabilities.elevenlabs) missing.push('ELEVENLABS_API_KEY');
  return missing;
}

if (!VOICE_ENABLED) {
  console.warn(
    `⚠️  Voice is off — missing: ${missingPieces().join(', ')}. ` +
    'The HUD works fully without it; add the keys to .env to enable talking to Jarvis.'
  );
}

// Short-lived token letting one browser join one room. Generated per request and
// never reused — the API secret itself never leaves the server.
async function createAccessToken({ roomName, identity }) {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '15m',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

module.exports = {
  VOICE_ENABLED,
  capabilities,
  missingPieces,
  createAccessToken,
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  DEEPGRAM_API_KEY,
  DEEPGRAM_MODEL,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID,
};

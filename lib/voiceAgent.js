// Jarvis's voice agent. Joins the same LiveKit room the HUD connects to, then:
//
//   mic audio (LiveKit)  ->  Deepgram streaming STT  ->  hudBrain (business data)
//                                                            |
//   speaker audio (LiveKit)  <-  ElevenLabs TTS  <------------+
//
// Runs in-process with the Express server so there's one thing to start, not two.

const { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind } = require('@livekit/rtc-node');
const { DeepgramClient } = require('@deepgram/sdk');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');

const voice = require('./voiceService');
const hudBrain = require('./hudBrain');
const activityLog = require('./activityLog');

// Deepgram is fed 16kHz mono, and ElevenLabs is asked for pcm_16000, so both
// ends of the pipeline share one sample rate and nothing needs resampling.
const SAMPLE_RATE = 16000;
const CHANNELS = 1;

const activeRooms = new Map(); // roomName -> { room, close() }

function toArrayBuffer(int16) {
  return int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
}

// Streams one reply into the room as audio. ElevenLabs hands back raw PCM16LE
// bytes; LiveKit wants Int16Array frames, and a byte chunk can end mid-sample,
// so a trailing odd byte is carried into the next chunk rather than dropped —
// dropping it would desync every subsequent sample by one byte and turn the
// rest of the sentence into noise.
async function speak({ source, elevenlabs, text }) {
  const audio = await elevenlabs.textToSpeech.convert(voice.ELEVENLABS_VOICE_ID, {
    text,
    modelId: voice.ELEVENLABS_MODEL_ID,
    outputFormat: `pcm_${SAMPLE_RATE}`,
  });

  let carry = Buffer.alloc(0);
  for await (const chunk of audio) {
    const buf = Buffer.concat([carry, Buffer.from(chunk)]);
    const usable = buf.length - (buf.length % 2);
    carry = buf.subarray(usable);
    if (usable === 0) continue;

    const samples = new Int16Array(usable / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = buf.readInt16LE(i * 2);
    }
    await source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, samples.length));
  }
}

// Wires one participant's microphone track through Deepgram and answers what
// they say. One STT socket per track, torn down when the track ends.
function listenToTrack({ track, source, deepgram, elevenlabs, getSnapshot, getDeps, onEvent }) {
  let socket;
  let closed = false;

  (async () => {
    try {
      socket = await deepgram.listen.v1.connect({
        model: voice.DEEPGRAM_MODEL,
        encoding: 'linear16',
        sample_rate: SAMPLE_RATE,
        channels: CHANNELS,
        punctuate: true,
        smart_format: true,
        interim_results: true,
        endpointing: 300,
      });

      socket.on('error', (err) => console.error('[voiceAgent] deepgram error:', err.message));

      socket.on('message', async (message) => {
        const alt = message?.channel?.alternatives?.[0];
        const transcript = alt?.transcript?.trim();
        if (!transcript) return;

        if (!message.is_final) {
          onEvent({ type: 'interim', text: transcript });
          return;
        }

        onEvent({ type: 'heard', text: transcript });
        try {
          // handle() also acts on spoken commands — "remind me to call Dave"
          // creates a real task, it isn't just answered conversationally.
          const { reply } = await hudBrain.handle(transcript, await getSnapshot(), getDeps());
          onEvent({ type: 'reply', text: reply });
          activityLog.log(`🎙️ "${transcript}" — ${reply}`);
          await speak({ source, elevenlabs, text: reply });
        } catch (err) {
          console.error('[voiceAgent] failed to answer:', err.message);
          onEvent({ type: 'error', text: err.message });
        }
      });

      const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: CHANNELS });
      for await (const frame of stream) {
        if (closed) break;
        socket.sendMedia(toArrayBuffer(frame.data));
      }
    } catch (err) {
      if (!closed) console.error('[voiceAgent] listen loop failed:', err.message);
    }
  })();

  return () => {
    closed = true;
    try { socket?.close?.(); } catch { /* already gone */ }
  };
}

// Joins a room as "jarvis" and starts listening. Idempotent per room name —
// the HUD calls this every time it connects, including on reconnect.
async function ensureAgent({ roomName, getSnapshot, getDeps = () => ({}), onEvent = () => {} }) {
  if (!voice.VOICE_ENABLED) {
    throw new Error(`Voice is not configured — missing: ${voice.missingPieces().join(', ')}`);
  }
  if (activeRooms.has(roomName)) return activeRooms.get(roomName);

  const deepgram = new DeepgramClient({ apiKey: voice.DEEPGRAM_API_KEY });
  const elevenlabs = new ElevenLabsClient({ apiKey: voice.ELEVENLABS_API_KEY });

  const room = new Room();
  const token = await voice.createAccessToken({ roomName, identity: 'jarvis' });
  await room.connect(voice.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: true });

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const outboundTrack = LocalAudioTrack.createAudioTrack('jarvis-voice', source);
  await room.localParticipant.publishTrack(
    outboundTrack,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
  );

  const stopFns = [];

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    stopFns.push(listenToTrack({ track, source, deepgram, elevenlabs, getSnapshot, getDeps, onEvent }));
  });

  // Nobody left but Jarvis — tear the room down rather than leaving an idle
  // agent (and its Deepgram socket) billing in the background.
  room.on(RoomEvent.ParticipantDisconnected, () => {
    if (room.remoteParticipants.size === 0) closeAgent(roomName);
  });

  const entry = {
    room,
    close: async () => {
      stopFns.forEach((fn) => fn());
      try { await room.disconnect(); } catch { /* already disconnected */ }
      activeRooms.delete(roomName);
    },
  };
  activeRooms.set(roomName, entry);

  const greeting = "Jarvis online. Ask me about your pipeline.";
  onEvent({ type: 'reply', text: greeting });
  speak({ source, elevenlabs, text: greeting }).catch((err) =>
    console.error('[voiceAgent] greeting failed:', err.message)
  );

  return entry;
}

async function closeAgent(roomName) {
  const entry = activeRooms.get(roomName);
  if (entry) await entry.close();
}

module.exports = { ensureAgent, closeAgent, SAMPLE_RATE };

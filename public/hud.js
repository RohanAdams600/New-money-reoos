'use strict';

const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function say(html) {
  $('say').innerHTML = html;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderBar(combined) {
  const bar = $('bar');
  const total = combined.total;
  if (!total) {
    bar.innerHTML = '<span class="seg-empty"></span>';
    return;
  }
  const pct = (n) => `${(n / total) * 100}%`;
  const segs = [];
  if (combined.hot) segs.push(`<span class="seg-hot" style="width:${pct(combined.hot)}"></span>`);
  if (combined.warm) segs.push(`<span class="seg-warm" style="width:${pct(combined.warm)}"></span>`);
  if (combined.cold) segs.push(`<span class="seg-cold" style="width:${pct(combined.cold)}"></span>`);
  bar.innerHTML = segs.join('');
}

function renderLeads(leads) {
  const el = $('leads');
  if (!leads.length) {
    el.innerHTML = '<li class="empty">No leads captured yet.</li>';
    return;
  }
  el.innerHTML = leads
    .map((l) => `
      <li>
        <span class="chip ${esc(l.classification)}">${esc(l.classification)}</span>
        <span>
          ${esc(l.companyName && l.companyName !== 'Not extracted (demo mode)' ? l.companyName : l.customerName)}
          <div class="who">${esc(l.from || l.source)} · ${l.confidence}% confidence</div>
        </span>
        <span class="when">${timeAgo(l.receivedAt)}</span>
      </li>`)
    .join('');
}

function renderActivity(activity) {
  const el = $('activity');
  if (!activity.length) {
    el.innerHTML = '<li class="empty">Nothing yet — Jarvis is watching.</li>';
    return;
  }
  el.innerHTML = activity
    .map((a) => `<li><span>${esc(a.message)}</span><span class="when">${timeAgo(a.at)}</span></li>`)
    .join('');
}

let lastOk = 0;

async function refresh() {
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    $('hero-total').textContent = d.combined.total;
    $('t-hot').textContent = d.combined.hot;
    $('t-warm').textContent = d.combined.warm;
    $('t-cold').textContent = d.combined.cold;
    $('s-own').textContent = d.own.total;
    $('s-clients').textContent = d.clients.total;

    renderBar(d.combined);
    renderLeads(d.recentLeads || []);
    renderActivity(d.activity || []);

    $('sub').textContent = `Jarvis · ${d.agentCount} agent${d.agentCount === 1 ? '' : 's'} · ${d.gmailConnected ? 'inbox connected' : 'inbox not connected'}`;

    const notice = $('demo-notice');
    if (d.demoMode) {
      notice.hidden = false;
      notice.innerHTML = 'Demo mode — leads are classified by a free rule-based stand-in, not Claude. Add a real <code>OPENROUTER_API_KEY</code> to switch it on.';
    } else {
      notice.hidden = true;
    }

    lastOk = Date.now();
    $('live-dot').classList.remove('stale');
  } catch (err) {
    // Only flag the connection as stale after a couple of failed polls, so one
    // dropped request on a phone changing networks doesn't flicker the light.
    if (Date.now() - lastOk > 20000) $('live-dot').classList.add('stale');
  }
}

refresh();
setInterval(refresh, 8000);
// Phones aggressively suspend background tabs; refresh the moment it's visible
// again rather than showing whatever was on screen when it got backgrounded.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

// ---------------------------------------------------------------------------
// Typed questions — always available, no voice keys needed
// ---------------------------------------------------------------------------

$('ask').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const question = e.target.value.trim();
  if (!question) return;
  e.target.value = '';
  say(`<b>You:</b> ${esc(question)}`);
  try {
    const res = await fetch('/api/hud/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    say(res.ok ? esc(data.reply) : `Couldn't answer: ${esc(data.error || res.status)}`);
    refresh();
  } catch (err) {
    say(`Couldn't reach Jarvis: ${esc(err.message)}`);
  }
});

// ---------------------------------------------------------------------------
// Voice — LiveKit in, Jarvis's ElevenLabs voice back out
// ---------------------------------------------------------------------------

let voiceConfig = null;
let room = null;

function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/livekit/livekit-client.umd.js';
    s.onload = () => resolve(window.LivekitClient);
    s.onerror = () => reject(new Error('Could not load the LiveKit browser SDK.'));
    document.head.appendChild(s);
  });
}

async function initVoiceConfig() {
  try {
    voiceConfig = await (await fetch('/api/voice/config')).json();
  } catch {
    voiceConfig = { enabled: false, missing: ['could not reach the server'] };
  }
  if (!voiceConfig.enabled) {
    $('mic').disabled = true;
    $('mic').title = `Voice off — missing: ${(voiceConfig.missing || []).join(', ')}`;
  }
}
initVoiceConfig();

async function startVoice() {
  const LK = await loadLiveKit();
  say('Connecting…');

  const res = await fetch('/api/voice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: 'nightdesk-hud' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.details || data.error || 'Could not get a voice token.');

  room = new LK.Room({ adaptiveStream: true, dynacast: true });

  room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === LK.Track.Kind.Audio) {
      // attach() returns an <audio> element already wired to the track; it has
      // to be in the DOM for iOS to actually play it.
      const el = track.attach();
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
  });

  room.on(LK.RoomEvent.Disconnected, () => {
    $('mic').classList.remove('live');
    say('Voice disconnected.');
    room = null;
  });

  await room.connect(data.url, data.token);
  await room.localParticipant.setMicrophoneEnabled(true);

  $('mic').classList.add('live');
  say('Listening — ask about your pipeline.');
}

async function stopVoice() {
  if (room) await room.disconnect();
  room = null;
  $('mic').classList.remove('live');
  say('');
}

$('mic').addEventListener('click', async () => {
  if (room) {
    stopVoice();
    return;
  }
  try {
    await startVoice();
  } catch (err) {
    say(`Voice failed: ${esc(err.message)}`);
    $('mic').classList.remove('live');
    room = null;
  }
});

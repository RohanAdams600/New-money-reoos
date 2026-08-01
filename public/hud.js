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

function whenLabel(iso, allDay) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = allDay
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

function renderCalendar(cal) {
  const el = $('calendar');
  const input = $('new-event');
  const state = (cal && cal.state) || 'not_configured';

  if (state !== 'connected') {
    input.disabled = true;
    const message = {
      not_configured: 'Google isn’t set up yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      not_connected: 'Not connected. <a href="/auth/google">Connect Google</a> to see your calendar.',
      // A token issued before Calendar existed in this app lacks the scope, so
      // this is a re-auth rather than a first-time connect — say which.
      needs_reauth: 'Connected to Gmail, but not Calendar. <a href="/auth/google">Re-authorize</a> to add calendar access.',
      error: `Couldn’t read the calendar: ${esc((cal && cal.error) || 'unknown error')}`,
    }[state] || 'Calendar unavailable.';
    el.innerHTML = `<li class="empty">${message}</li>`;
    $('cal-count').textContent = '';
    return;
  }

  input.disabled = false;
  const events = cal.upcoming || [];
  $('cal-count').textContent = events.length ? events.length : '';

  if (!events.length) {
    el.innerHTML = '<li class="empty">Nothing scheduled this week.</li>';
    return;
  }

  el.innerHTML = events
    .map((e) => `
      <li>
        <span class="task-body">
          ${esc(e.title)}
          <div class="meta">${esc(whenLabel(e.start, e.allDay))}${e.attendees.length ? ` · ${esc(e.attendees.length)} invited` : ''}${e.meetLink ? ' · Meet' : ''}</div>
        </span>
        ${e.attendees.length ? `<button class="invite-btn" data-invite="${esc(e.id)}">Invite</button>` : ''}
      </li>`)
    .join('');
}

$('calendar').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-invite]');
  if (!btn) return;
  if (!confirm('Email the invite to everyone on this event?')) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/calendar/events/${btn.dataset.invite}/invite`, { method: 'POST' });
    const data = await res.json();
    say(res.ok ? `Invite sent to ${esc(data.attendees.join(', '))}.` : `Couldn’t send: ${esc(data.details || data.error)}`);
  } catch (err) {
    say(`Couldn’t send the invite: ${esc(err.message)}`);
  }
  refresh();
});

$('new-event').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = e.target.value.trim();
  if (!text) return;
  e.target.value = '';
  say('Booking…');
  try {
    const res = await fetch('/api/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    // Always echo the parsed time back — it's the only way a misread
    // "at 2" gets caught before an invite goes out.
    say(res.ok
      ? `Booked “${esc(data.event.title)}” for ${esc(data.parsed.spokenTime)}.`
      : `Couldn’t book that: ${esc(data.details || data.error)}`);
    refresh();
  } catch (err) {
    say(`Couldn’t book that: ${esc(err.message)}`);
  }
});

function renderTasks(taskState) {
  const el = $('tasks');
  const open = (taskState && taskState.open) || [];
  $('task-count').textContent = open.length ? open.length : '';

  if (!open.length) {
    el.innerHTML = '<li class="empty">Nothing on your list.</li>';
    return;
  }

  el.innerHTML = open
    .map((t) => `
      <li class="${t.priority === 'high' ? 'task-high' : ''}">
        <button class="check" data-done="${esc(t.id)}" aria-label="Complete task"><i></i></button>
        <span class="task-body">
          ${esc(t.title)}
          ${t.notes ? `<div class="meta">${esc(t.notes)}</div>` : ''}
        </span>
        <button class="task-del" data-del="${esc(t.id)}" aria-label="Delete task">&times;</button>
      </li>`)
    .join('');
}

// Delegated so the handlers survive the list being re-rendered on every poll.
$('tasks').addEventListener('click', async (e) => {
  const done = e.target.closest('[data-done]');
  const del = e.target.closest('[data-del]');
  try {
    if (done) {
      await fetch(`/api/tasks/${done.dataset.done}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
    } else if (del) {
      await fetch(`/api/tasks/${del.dataset.del}`, { method: 'DELETE' });
    } else {
      return;
    }
    refresh();
  } catch (err) {
    say(`Couldn't update that task: ${esc(err.message)}`);
  }
});

$('new-task').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const title = e.target.value.trim();
  if (!title) return;
  e.target.value = '';
  try {
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    refresh();
  } catch (err) {
    say(`Couldn't add that: ${esc(err.message)}`);
  }
});

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
    renderCalendar(d.calendar);
    renderTasks(d.tasks);
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

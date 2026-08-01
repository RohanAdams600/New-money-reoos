// Jarvis's Google Calendar connection: see what's on the schedule, and book
// meetings — including sending an invite to a lead.
//
// ON SENDING INVITES: creating an event with attendees emails real people.
// That's an outward-facing action on Rohan's behalf, so it follows the same
// rule as GMAIL_AUTO_SEND — the event is created on the calendar immediately,
// but attendees are NOT notified until that's explicitly confirmed. Set
// CALENDAR_AUTO_INVITE=true to skip the confirmation step once you trust it.

const { google } = require('googleapis');
const auth = require('./googleAuth');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const AUTO_INVITE = process.env.CALENDAR_AUTO_INVITE === 'true';
const DEFAULT_MEETING_MINUTES = parseInt(process.env.DEFAULT_MEETING_MINUTES, 10) || 30;

function getCalendarClient(baseUrl) {
  const authClient = auth.getAuthedClient(baseUrl);
  if (!authClient) return null;
  return google.calendar({ version: 'v3', auth: authClient });
}

function isConnected() {
  return auth.hasCalendarAccess();
}

// Distinguishes "never connected Google at all" from "connected before Calendar
// existed in this app, so the token predates the calendar scope" — the second
// needs a re-auth, not a first-time setup, and the UI should say so.
function status() {
  if (!auth.isConfigured()) return { state: 'not_configured' };
  if (!auth.isConnected()) return { state: 'not_connected' };
  if (!auth.hasCalendarAccess()) return { state: 'needs_reauth' };
  return { state: 'connected' };
}

async function listUpcoming(baseUrl, { maxResults = 10, days = 7 } = {}) {
  const calendar = getCalendarClient(baseUrl);
  if (!calendar) return [];

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    maxResults,
    singleEvents: true,   // expand recurring events into individual instances
    orderBy: 'startTime', // only valid alongside singleEvents
  });

  return (data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || '(no title)',
    // All-day events carry `date` instead of `dateTime`.
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location || null,
    meetLink: e.hangoutLink || null,
    attendees: (e.attendees || []).map((a) => a.email),
    htmlLink: e.htmlLink,
  }));
}

// Creates the event. `notify` controls whether attendees actually get emailed —
// see the module header for why that defaults to off.
async function createEvent(baseUrl, { title, startIso, minutes = DEFAULT_MEETING_MINUTES, attendees = [], description = '', location = '', addMeetLink = true, notify = AUTO_INVITE }) {
  const calendar = getCalendarClient(baseUrl);
  if (!calendar) throw new Error('Calendar is not connected.');

  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error(`Could not read "${startIso}" as a date and time.`);
  const end = new Date(start.getTime() + minutes * 60 * 1000);

  const requestBody = {
    summary: title,
    description,
    location,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: attendees.map((email) => ({ email })),
  };

  // A Meet link needs a conferenceData request with a unique id, plus
  // conferenceDataVersion: 1 on the call — without both, Google silently
  // ignores it and you get an event with no link.
  if (addMeetLink && attendees.length) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `jarvis-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const { data } = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    conferenceDataVersion: 1,
    sendUpdates: notify ? 'all' : 'none',
    requestBody,
  });

  return {
    id: data.id,
    title: data.summary,
    start: data.start?.dateTime,
    end: data.end?.dateTime,
    attendees: (data.attendees || []).map((a) => a.email),
    meetLink: data.hangoutLink || null,
    htmlLink: data.htmlLink,
    invitesSent: Boolean(notify) && (data.attendees || []).length > 0,
  };
}

// Emails the invite for an event that was created without notifying anyone.
// This is the explicit confirmation step.
async function sendInvites(baseUrl, eventId) {
  const calendar = getCalendarClient(baseUrl);
  if (!calendar) throw new Error('Calendar is not connected.');

  const { data: existing } = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
  if (!existing.attendees || existing.attendees.length === 0) {
    throw new Error('That event has no attendees to invite.');
  }

  // Google only emails attendees on a write, so re-send by patching the event
  // with sendUpdates: 'all'. Patching with its own attendee list changes
  // nothing about the event itself and triggers the notification.
  const { data } = await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    sendUpdates: 'all',
    requestBody: { attendees: existing.attendees },
  });

  return {
    id: data.id,
    title: data.summary,
    attendees: (data.attendees || []).map((a) => a.email),
    invitesSent: true,
  };
}

async function deleteEvent(baseUrl, eventId, { notify = false } = {}) {
  const calendar = getCalendarClient(baseUrl);
  if (!calendar) throw new Error('Calendar is not connected.');
  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId,
    sendUpdates: notify ? 'all' : 'none',
  });
  return true;
}

module.exports = {
  CALENDAR_ID,
  AUTO_INVITE,
  DEFAULT_MEETING_MINUTES,
  isConnected,
  status,
  listUpcoming,
  createEvent,
  sendInvites,
  deleteEvent,
};

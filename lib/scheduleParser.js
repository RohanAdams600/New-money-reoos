// Turns "book a call with jane@acme.com tomorrow at 2" into a concrete event.
//
// Kept separate from hudBrain so it can be tested exhaustively on its own —
// getting a meeting time wrong is one of the few failures here that costs a
// real relationship, not just a confusing reply.

const chrono = require('chrono-node');

// The timezone meeting times should be interpreted in. Defaults to whatever
// the host is set to, which on most cloud hosts is UTC — set TIMEZONE in .env
// (e.g. "America/New_York") or every booking lands hours off.
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// "half an hour", "45 min", "1 hour", "2hr", "an hour".
// The lookbehind matters: "book AN HOUR with Dave" states a duration, but
// "call me IN AN HOUR" states a start time. Without it the second gets
// stripped as a duration and the meeting loses its actual time.
const DURATION_RE = /\b(?:for\s+)?(?:(half)\s+an?\s+hour|(?<!\bin\s)an?\s+(hour)\b|(\d+)\s*(?:-|\s)?\s*(min(?:ute)?s?|hours?|hrs?|h)\b)/i;

const MEETING_WORDS = /\b(call|meeting|demo|chat|appointment|catch[- ]?up|sync|interview|coffee)\b/i;

function parseDuration(text) {
  const m = text.match(DURATION_RE);
  if (!m) return null;
  if (m[1]) return 30; // "half an hour"
  if (m[2]) return 60; // "an hour"

  const value = parseInt(m[3], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return /^h/i.test(m[4]) ? value * 60 : value;
}

// chrono ignores IANA timezone names — passing "America/New_York" behaves
// identically to passing nothing, so wall-clock times get read in the host's
// zone (UTC on most cloud hosts) and land hours off. It does honour a numeric
// UTC offset, so resolve the zone to an offset for the reference date, which
// also keeps DST correct instead of hardcoding a single offset year-round.
function offsetMinutesFor(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(date)
      .reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0; // unknown zone name — fall back to UTC rather than throwing
  }
}

// chrono reads a bare "at 2" as 02:00, so "tomorrow at 2" becomes 2 in the
// morning. For a business scheduling tool that's almost never meant, and the
// failure is silent — the event just lands overnight. When an hour lands
// between 1 and 7 and the text gives no explicit AM signal, read it as
// afternoon. 8-11 are left alone: "at 9" plausibly means 9am.
function looksLikeAmbiguousAfternoon(text, parsed) {
  const hour = parsed.get('hour');
  if (hour === null || hour === undefined || hour < 1 || hour > 7) return false;
  if (parsed.isCertain('meridiem')) return false;
  return !/\b(a\.?m\.?|morning|midnight|overnight|tonight)\b/i.test(text);
}

/**
 * @returns {null | { title, attendees, startIso, minutes, spokenTime, ambiguousMeridiem }}
 *          null when no usable date/time could be found.
 */
function parseSchedulingRequest(text, now = new Date()) {
  const input = String(text || '').trim();
  if (!input) return null;

  const attendees = Array.from(new Set(input.match(EMAIL_RE) || []));
  // Strip emails before date parsing — chrono otherwise reads digits inside an
  // address as part of a date.
  const withoutEmails = input.replace(EMAIL_RE, ' ');

  // Duration has to come out BEFORE the date parse, not after: chrono happily
  // reads "45 min" in "a 45 min meeting friday 3pm" as the time itself and
  // returns 9:45am, never reaching the actual "friday 3pm".
  const minutes = parseDuration(withoutEmails) || 30;
  const forDateParse = withoutEmails.replace(DURATION_RE, ' ');

  const results = chrono.parse(
    forDateParse,
    { instant: now, timezone: offsetMinutesFor(TIMEZONE, now) },
    { forwardDate: true }
  );
  if (!results.length) return null;

  const result = results[0];
  let start = result.start.date();
  let ambiguousMeridiem = false;

  if (looksLikeAmbiguousAfternoon(forDateParse, result.start)) {
    start = new Date(start.getTime() + 12 * 60 * 60 * 1000);
    ambiguousMeridiem = true;
  }

  // An explicit range ("from 7-10pm", "2 to 3:30") states its own length, so it
  // wins over both the duration phrase and the default. chrono only fills
  // result.end when it actually saw a range.
  let rangeMinutes = null;
  if (result.end) {
    let end = result.end.date();
    // "7-10 pm": the meridiem is often only stated on the end, leaving the
    // start read as 7am and the range spanning 15 hours. When the end carries
    // a certain PM and the start doesn't, the start is the same afternoon.
    if (end <= start && result.end.isCertain('meridiem') && !result.start.isCertain('meridiem')) {
      start = new Date(start.getTime() + 12 * 60 * 60 * 1000);
      ambiguousMeridiem = true;
    }
    const span = Math.round((end - start) / 60000);
    if (span > 0 && span <= 24 * 60) rangeMinutes = span;
  }

  // An explicit name always wins: "…called Cousins dinner", "titled Q3 review".
  // Matched against the text with the date phrase already removed, so
  // "titled Q3 review at 10am" yields "Q3 review" and not the trailing time.
  const withoutDate = forDateParse.replace(result.text, ' ').replace(/\s+/g, ' ');
  const namedMatch = withoutDate.match(/\b(?:called|titled|named|about)\s+["']?(.+?)["']?\s*$/i);
  if (namedMatch && namedMatch[1].trim().length > 1) {
    return {
      title: namedMatch[1].trim(),
      attendees,
      startIso: start.toISOString(),
      minutes: rangeMinutes || minutes,
      spokenTime: formatWhen(start),
      ambiguousMeridiem,
    };
  }

  // Otherwise: whatever's left once the date phrase, duration, and filler verbs
  // are removed. Falls back to naming the meeting after whoever's invited.
  let title = forDateParse
    .replace(result.text, ' ')
    .replace(/^\s*(?:can you\s+|please\s+)?(?:book|schedule|set up|setup|arrange|put in|add)\b/i, ' ')
    .replace(/\b(?:a|an|the|with|for|on|at|in|to|me)\b/gi, ' ')
    .replace(/[^\w\s'&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || title.length < 3) {
    const who = attendees[0] ? attendees[0].split('@')[0] : null;
    const kind = (withoutEmails.match(MEETING_WORDS) || [])[0] || 'Meeting';
    title = who ? `${kind[0].toUpperCase()}${kind.slice(1)} with ${who}` : `${kind[0].toUpperCase()}${kind.slice(1)}`;
  } else {
    title = title[0].toUpperCase() + title.slice(1);
  }

  return {
    title,
    attendees,
    startIso: start.toISOString(),
    minutes: rangeMinutes || minutes,
    spokenTime: formatWhen(start),
    ambiguousMeridiem,
  };
}

// Human-readable time, always in the configured timezone, so the confirmation
// Jarvis reads back is checkable — this is the safety net against a
// misparsed time going out as a real invite.
function formatWhen(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TIMEZONE,
    timeZoneName: 'short',
  }).format(date);
}

module.exports = { parseSchedulingRequest, formatWhen, TIMEZONE };

// Shared Google OAuth for everything Jarvis touches in Rohan's Google account:
// Gmail (read labelled leads, draft replies) and Calendar (see the schedule,
// book meetings). Single-user by design — this whole app is one person's
// instance, so there's exactly one connected account and its token lives in a
// local file, not a database.
//
// One token, all scopes. Gmail and Calendar deliberately share this module
// rather than each keeping their own: they authorise through the same consent
// screen and write the same file, so separate copies would overwrite each
// other's token and silently drop whichever scope authorised second.
//
// Setup Rohan does once (Jarvis can't click through Google's consent screen):
//   1. https://console.cloud.google.com -> new project
//   2. Enable BOTH the "Gmail API" and the "Google Calendar API"
//   3. OAuth consent screen -> External -> add your Gmail address as a test user
//   4. Credentials -> Create OAuth client ID -> Web application ->
//      authorized redirect URI: {APP_URL}/auth/google/callback
//   5. Put the client ID/secret in .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   6. Visit GET /auth/google on the running app and approve

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || process.env.GMAIL_TOKEN_PATH || path.join(__dirname, '..', '.gmail-token.json');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify', // read + label + draft
  'https://www.googleapis.com/auth/gmail.send',   // only exercised if GMAIL_AUTO_SEND is on
];

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', // read + create events (not full calendar admin)
];

const SCOPES = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(baseUrl) {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl}/auth/google/callback`;
}

function getOAuthClient(baseUrl) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(baseUrl)
  );
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

function isConnected() {
  return isConfigured() && loadToken() !== null;
}

// Which scopes the stored token was actually granted. Google returns these as a
// space-separated string on the token. A token issued before Calendar was added
// won't carry the calendar scope, so anything calendar-related has to check
// this and ask for re-authorisation rather than failing with a raw 403.
function grantedScopes() {
  const token = loadToken();
  if (!token || !token.scope) return [];
  return String(token.scope).split(/\s+/).filter(Boolean);
}

function hasScopes(required) {
  const granted = grantedScopes();
  return required.every((scope) => granted.includes(scope));
}

const hasGmailAccess = () => isConnected() && hasScopes(GMAIL_SCOPES);
const hasCalendarAccess = () => isConnected() && hasScopes(CALENDAR_SCOPES);

function getAuthUrl(baseUrl) {
  const oAuth2Client = getOAuthClient(baseUrl);
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline', // needed to get a refresh_token back
    prompt: 'consent',      // forces a refresh_token even on repeat authorizations
    scope: SCOPES,
  });
}

async function handleOAuthCallback(code, baseUrl) {
  const oAuth2Client = getOAuthClient(baseUrl);
  const { tokens } = await oAuth2Client.getToken(code);
  // Merge rather than replace: re-authorising sometimes returns no refresh_token
  // (Google only issues one on first consent for a given client), and blindly
  // overwriting would drop the one already held and break silent refresh.
  const existing = loadToken() || {};
  saveToken({ ...existing, ...tokens });
  return tokens;
}

// An OAuth2 client with the stored credentials loaded, or null if not connected.
function getAuthedClient(baseUrl) {
  const token = loadToken();
  if (!token) return null;

  const oAuth2Client = getOAuthClient(baseUrl);
  oAuth2Client.setCredentials(token);
  // googleapis refreshes access tokens automatically using the stored
  // refresh_token; persist what it refreshes so future requests don't redo it.
  oAuth2Client.on('tokens', (newTokens) => {
    saveToken({ ...loadToken(), ...newTokens });
  });

  return oAuth2Client;
}

module.exports = {
  TOKEN_PATH,
  SCOPES,
  GMAIL_SCOPES,
  CALENDAR_SCOPES,
  isConfigured,
  isConnected,
  grantedScopes,
  hasScopes,
  hasGmailAccess,
  hasCalendarAccess,
  getAuthUrl,
  handleOAuthCallback,
  getAuthedClient,
};

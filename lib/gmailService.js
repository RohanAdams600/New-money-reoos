// Jarvis's Gmail connection — OAuth setup, reading labeled lead emails, and
// drafting (or, opt-in, sending) replies. Single-user by design: this whole app
// is Rohan's personal instance, so there's exactly one Gmail account connected
// and its token lives in a local file, not a database.
//
// Setup Rohan needs to do once (Jarvis can't click through Google's consent
// screen for him):
//   1. https://console.cloud.google.com -> new project -> enable the Gmail API.
//   2. OAuth consent screen -> External -> add rohanadams352@gmail.com as a test user.
//   3. Credentials -> Create OAuth client ID -> Web application ->
//      authorized redirect URI: {APP_URL}/auth/google/callback
//   4. Put the resulting client ID/secret in .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
//   5. Visit GET /auth/google on the running app and approve access.
//   6. In Gmail, create a label (default name "Jarvis") and a filter that applies
//      it to whatever should count as a lead (e.g. a contact-form notification
//      address, or anything sent to a specific alias). Jarvis only ever reads
//      mail under that label — never the rest of the inbox.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || path.join(__dirname, '..', '.gmail-token.json');
const LABEL_NAME = process.env.GMAIL_LABEL || 'Jarvis';
// Off by default — see the module comment on lib/jarvis.js's capabilities and the
// README-level warning: sending real email from Rohan's own Gmail with no human
// review is a deliberate opt-in, not the default behavior.
const AUTO_SEND = process.env.GMAIL_AUTO_SEND === 'true';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify', // read + label + draft
  'https://www.googleapis.com/auth/gmail.send',   // only exercised if AUTO_SEND is on
];

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
  saveToken(tokens);
  return tokens;
}

// Returns an authenticated Gmail client, or null if Jarvis isn't connected yet.
function getGmailClient(baseUrl) {
  const token = loadToken();
  if (!token) return null;

  const oAuth2Client = getOAuthClient(baseUrl);
  oAuth2Client.setCredentials(token);
  // googleapis refreshes access tokens automatically using the stored refresh_token;
  // persist whatever it refreshes to so future requests don't need to redo the dance.
  oAuth2Client.on('tokens', (newTokens) => {
    saveToken({ ...token, ...newTokens });
  });

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

async function getConnectedEmail(baseUrl) {
  const gmail = getGmailClient(baseUrl);
  if (!gmail) return null;
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return profile.data.emailAddress;
}

async function findLabelId(gmail, labelName) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const label = (data.labels || []).find((l) => l.name.toLowerCase() === labelName.toLowerCase());
  return label ? label.id : null;
}

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64url').toString('utf8');
}

// Gmail messages are a tree of MIME parts — walk it for the first text/plain part,
// falling back to text/html stripped of tags if that's all there is.
function extractBody(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Fetches unread messages under Jarvis's label — the only mail Jarvis ever touches.
async function listLeadMessages(baseUrl) {
  const gmail = getGmailClient(baseUrl);
  if (!gmail) return [];

  const labelId = await findLabelId(gmail, LABEL_NAME);
  if (!labelId) return []; // label doesn't exist yet — nothing to do until Rohan creates it

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [labelId, 'UNREAD'],
    maxResults: 20,
  });

  const messages = [];
  for (const m of data.messages || []) {
    const { data: full } = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.payload?.headers;
    messages.push({
      id: full.id,
      threadId: full.threadId,
      from: header(headers, 'From'),
      subject: header(headers, 'Subject'),
      body: extractBody(full.payload) || full.snippet || '',
    });
  }
  return messages;
}

function extractEmailAddress(fromHeader) {
  const match = String(fromHeader || '').match(/<([^>]+)>/);
  return match ? match[1] : fromHeader;
}

function buildRawReply({ to, subject, body, threadHeaders }) {
  const replySubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (threadHeaders.messageId) {
    lines.push(`In-Reply-To: ${threadHeaders.messageId}`);
    lines.push(`References: ${threadHeaders.messageId}`);
  }
  lines.push('', body);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function getThreadHeaders(gmail, messageId) {
  const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['Message-ID'] });
  return { messageId: header(data.payload?.headers, 'Message-ID') };
}

// Drafts a reply in Gmail for Rohan to review and send himself — the default,
// safe path (see the AUTO_SEND flag above).
async function createDraftReply(baseUrl, leadMessage, replyText) {
  const gmail = getGmailClient(baseUrl);
  if (!gmail) return null;

  const to = extractEmailAddress(leadMessage.from);
  const threadHeaders = await getThreadHeaders(gmail, leadMessage.id);
  const raw = buildRawReply({ to, subject: leadMessage.subject, body: replyText, threadHeaders });

  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId: leadMessage.threadId } },
  });
  return data;
}

// Sends the reply immediately instead of drafting it — only ever called when
// GMAIL_AUTO_SEND=true is explicitly set.
async function sendReply(baseUrl, leadMessage, replyText) {
  const gmail = getGmailClient(baseUrl);
  if (!gmail) return null;

  const to = extractEmailAddress(leadMessage.from);
  const threadHeaders = await getThreadHeaders(gmail, leadMessage.id);
  const raw = buildRawReply({ to, subject: leadMessage.subject, body: replyText, threadHeaders });

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: leadMessage.threadId },
  });
  return data;
}

// Marks a lead email read so it isn't picked up again on the next poll. Jarvis
// never deletes or archives — the email stays in the inbox under Jarvis's label.
async function markProcessed(baseUrl, messageId) {
  const gmail = getGmailClient(baseUrl);
  if (!gmail) return;
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

module.exports = {
  LABEL_NAME,
  AUTO_SEND,
  isConfigured,
  isConnected,
  getAuthUrl,
  handleOAuthCallback,
  getConnectedEmail,
  listLeadMessages,
  createDraftReply,
  sendReply,
  markProcessed,
};

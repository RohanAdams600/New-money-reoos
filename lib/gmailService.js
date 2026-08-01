// Jarvis's Gmail connection — reading labelled lead emails and drafting (or,
// opt-in, sending) replies. OAuth itself lives in lib/googleAuth.js, shared
// with the Calendar integration so both authorise through one consent screen
// and one stored token.
//
// Setup Rohan does once — see the full step-by-step in lib/googleAuth.js. The
// Gmail-specific part: create a label (default "Jarvis") and a filter that
// applies it to whatever should count as a lead (e.g. contact-form
// notifications, or anything to a specific alias). Jarvis only ever reads mail
// under that label — never the rest of the inbox.

const { google } = require('googleapis');
const auth = require('./googleAuth');

const LABEL_NAME = process.env.GMAIL_LABEL || 'Jarvis';
// Off by default — sending real email from Rohan's own account with no human
// review is a deliberate opt-in, not the default behavior.
const AUTO_SEND = process.env.GMAIL_AUTO_SEND === 'true';

const TOKEN_PATH = auth.TOKEN_PATH;
const SCOPES = auth.GMAIL_SCOPES;

const isConfigured = auth.isConfigured;
const isConnected = auth.isConnected;
const getAuthUrl = auth.getAuthUrl;
const handleOAuthCallback = auth.handleOAuthCallback;

// Returns an authenticated Gmail client, or null if Jarvis isn't connected yet.
function getGmailClient(baseUrl) {
  const authClient = auth.getAuthedClient(baseUrl);
  if (!authClient) return null;
  return google.gmail({ version: 'v1', auth: authClient });
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

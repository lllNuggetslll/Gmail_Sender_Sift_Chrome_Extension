// Gmail Sender Sift — background service worker
//
// Personal-use only. Every network call in this file goes straight to
// gmail.googleapis.com using your own OAuth token — no third-party server,
// no telemetry, nothing phoned home.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LIST_PAGE_SIZE = 500;
const DETAIL_CONCURRENCY = 25;
const MAX_MESSAGES_DEFAULT = 3000; // bump this if you want deeper scans; Gmail's API quota is generous

// OAuth — standard web-application-flow client, NOT a "Chrome Extension"
// type client. Create this in Google Cloud Console under Credentials →
// Create Credentials → OAuth client ID → Application type: Web application,
// with Authorized redirect URI set to chrome.identity.getRedirectURL()'s
// value for this extension (see README.md). Paste the client ID below.
const OAUTH_CLIENT_ID = 'REPLACE_WITH_YOUR_WEB_APP_CLIENT_ID.apps.googleusercontent.com';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: OAUTH_SCOPE,
    prompt: 'consent',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function launchAuth() {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: buildAuthUrl(), interactive: true },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No redirect received'));
          return;
        }
        const hash = redirectUrl.split('#')[1] || '';
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        const error = params.get('error');
        const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
        if (error) reject(new Error(error));
        else if (!token) reject(new Error('No access_token in redirect'));
        else resolve({ token, expiresIn });
      }
    );
  });
}

// Token cache. This lives in the service worker + chrome.storage.session,
// NOT in content.js — content.js's in-memory state gets wiped every time
// the Gmail tab reloads (which happens after every archive/trash), so
// caching the token there alone meant every reload forced a fresh
// interactive consent screen. Caching it here means a reload just asks
// the background worker for the token it already has.
let cachedToken = null;
let cachedTokenExpiry = 0; // epoch ms

async function getCachedToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  try {
    const stored = await chrome.storage.session.get(['ssToken', 'ssTokenExpiry']);
    if (stored.ssToken && stored.ssTokenExpiry && Date.now() < stored.ssTokenExpiry) {
      cachedToken = stored.ssToken;
      cachedTokenExpiry = stored.ssTokenExpiry;
      return cachedToken;
    }
  } catch (e) { /* storage.session unavailable — fall through to a fresh auth */ }
  return null;
}

async function setCachedToken(token, expiresInSeconds) {
  cachedToken = token;
  cachedTokenExpiry = Date.now() + Math.max(0, expiresInSeconds - 60) * 1000; // 60s safety margin
  try {
    await chrome.storage.session.set({ ssToken: token, ssTokenExpiry: cachedTokenExpiry });
  } catch (e) { /* non-fatal — still cached in memory for this worker's lifetime */ }
}

function clearCachedToken() {
  cachedToken = null;
  cachedTokenExpiry = 0;
  try { chrome.storage.session.remove(['ssToken', 'ssTokenExpiry']); } catch (e) { /* non-fatal */ }
}

async function getToken() {
  const cached = await getCachedToken();
  if (cached) return cached;
  const { token, expiresIn } = await launchAuth();
  await setCachedToken(token, expiresIn);
  return token;
}

let cancelRequested = false;

let progressPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sift-progress') return;
  progressPorts.add(port);
  port.onDisconnect.addListener(() => progressPorts.delete(port));
});

function reportProgress(done, total, phase) {
  for (const port of progressPorts) {
    try { port.postMessage({ done, total, phase }); } catch (e) { /* port closed */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AUTH') {
    getToken()
      .then((token) => sendResponse({ token }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'SCAN') {
    cancelRequested = false;
    runScan(msg.token, msg.query, msg.maxMessages || MAX_MESSAGES_DEFAULT)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'STOP_SCAN') {
    cancelRequested = true;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'MODIFY') {
    batchModify(msg.token, msg.ids, msg.addLabels, msg.removeLabels)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function apiFetch(token, path, opts = {}) {
  const res = await fetch(GMAIL_API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) clearCachedToken(); // stale/revoked — don't keep handing this one out
    throw new Error(`Gmail API ${res.status}: ${text.slice(0, 200)}`);
  }
  // batchModify (and some other Gmail API calls) return 204 No Content on
  // success — an empty body, which res.json() can't parse. Read as text
  // first and only parse if there's actually something there.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function listMessageIds(token, query, cap) {
  const ids = [];
  let pageToken = '';
  while (ids.length < cap) {
    if (cancelRequested) break;
    let path = `/messages?maxResults=${LIST_PAGE_SIZE}`;
    path += query ? `&q=${encodeURIComponent(query)}` : '&labelIds=INBOX';
    if (pageToken) path += `&pageToken=${pageToken}`;
    const data = await apiFetch(token, path);
    for (const m of data.messages || []) {
      if (ids.length >= cap) break;
      ids.push(m.id);
    }
    if (!data.nextPageToken || ids.length >= cap) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

function parseFrom(headerValue) {
  const m = headerValue.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const rawName = m && m[1] ? m[1].trim() : '';
  const email = (m && m[2] ? m[2].trim() : headerValue).toLowerCase();
  return { name: rawName || email, email };
}

function parseUnsub(headerValue) {
  if (!headerValue) return { http: '', mailto: '' };
  const http = (headerValue.match(/<(https?:[^>]+)>/) || [])[1] || '';
  const mailto = (headerValue.match(/<(mailto:[^>]+)>/) || [])[1] || '';
  return { http, mailto };
}

async function fetchOne(token, id) {
  const headers = ['From', 'Subject', 'Date', 'List-Unsubscribe'];
  const q = headers.map((h) => `metadataHeaders=${h}`).join('&');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await apiFetch(token, `/messages/${id}?format=metadata&${q}`);
    } catch (err) {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
    }
  }
  return null;
}

async function runScan(token, query, cap) {
  reportProgress(0, 0, 'listing');
  const ids = await listMessageIds(token, query, cap);
  const total = ids.length;
  if (total === 0) {
    const stopped = cancelRequested;
    cancelRequested = false;
    reportProgress(0, 0, stopped ? 'stopped' : 'done');
    return { groups: [], stopped };
  }

  const groups = new Map();
  let done = 0;
  let stopped = false;
  for (let i = 0; i < ids.length; i += DETAIL_CONCURRENCY) {
    if (cancelRequested) { stopped = true; break; }
    const batch = ids.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((id) => fetchOne(token, id)));
    for (const msg of details) {
      done++;
      if (!msg || !msg.payload) continue;
      const h = {};
      for (const header of msg.payload.headers || []) h[header.name] = header.value;
      const { name, email } = parseFrom(h.From || '(unknown sender)');
      const { http, mailto } = parseUnsub(h['List-Unsubscribe'] || '');
      const key = email || name;
      if (!groups.has(key)) {
        groups.set(key, { name, email, unsubHttp: http, unsubMailto: mailto, unreadCount: 0, items: [] });
      }
      const g = groups.get(key);
      const unread = (msg.labelIds || []).includes('UNREAD');
      if (unread) g.unreadCount++;
      if (!g.unsubHttp && http) g.unsubHttp = http;
      if (!g.unsubMailto && mailto) g.unsubMailto = mailto;
      g.items.push({
        gmailId: msg.id,
        threadId: msg.threadId,
        subject: h.Subject || '(no subject)',
        date: h.Date || '',
        unread,
      });
    }
    reportProgress(done, total, 'details');
  }
  reportProgress(done, total, stopped ? 'stopped' : 'done');
  cancelRequested = false;
  return { groups: Array.from(groups.values()), stopped };
}

async function batchModify(token, ids, addLabels, removeLabels) {
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const body = { ids: chunk };
    if (addLabels && addLabels.length) body.addLabelIds = addLabels;
    if (removeLabels && removeLabels.length) body.removeLabelIds = removeLabels;
    await apiFetch(token, '/messages/batchModify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

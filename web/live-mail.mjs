// Replaces local-db.mjs in the real-mail release. The UI keeps its state model: this adapter
// loads mailbox metadata, fetches bodies on demand, and turns state changes into API calls.
import { parseRecipients } from './model.mjs';

export const sharedStorage = true;
export const liveMail = true;
const COLORS = { 'example.org': '#365f8c' };
const PREFERENCES = { notifications: false, externalImages: false };
const INLINE_LIMIT = 10 * 1024 * 1024;
let entryBaseline = new Map(), draftBaseline = new Map(), dirty = false, csrf;
const uploads = new Map(); // attachment id -> { key, sha256 }, so a draft re-save never re-uploads
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const dataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
export const hasUnsavedChanges = () => dirty;

async function call(path, value = {}, retried = false) {
  if (!csrf) {
    const session = await fetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!session.ok) throw Object.assign(new Error('Sign in again to continue. Unsaved drafts stay in this tab.'), { status: 401 });
    csrf = (await session.json()).csrf;
  }
  const body = JSON.stringify(value);
  const response = await fetch(path, { method: 'POST', cache: 'no-store', credentials: 'same-origin', body,
    headers: { 'content-type': 'application/json', 'x-inbox-csrf': csrf, 'x-amz-content-sha256': await sha(new TextEncoder().encode(body)) } });
  if (response.status === 403 && !retried) { csrf = undefined; return call(path, value, true); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Mail is unavailable right now. Please try again.'), { status: response.status });
  return result;
}
async function fetchBlob(url, type) { const response = await fetch(url); if (!response.ok) throw new Error('A file could not be downloaded.'); return new Blob([await response.arrayBuffer()], { type }); }

export function storageActions(notice) {
  const reload = document.createElement('button'); reload.className = 'text-button'; reload.textContent = 'Reload mail';
  reload.onclick = () => { if (!dirty || confirm('Reload and discard changes that were not saved?')) location.reload(); };
  notice.append(document.createTextNode(' '), reload);
}

const entryKey = (domain, id, address) => `${domain}\u0000${id}\u0000${address}`;
function entrySnapshot(messages) {
  const map = new Map();
  for (const message of messages) for (const [address, entry] of Object.entries(message.mailboxes || {})) map.set(entryKey(message.domain, message.id, address), { folder: entry.folder, read: Boolean(entry.read) });
  return map;
}

// Draft attachments are uploaded once; inline images travel as cid: references.
async function encodeDraft(draft) {
  const wire = { ...draft, attachments: [] };
  for (const file of draft.attachments || []) {
    let stored = file.key ? { key: file.key, sha256: file.sha256 } : uploads.get(file.id);
    if (!stored) {
      const blob = file.blob || (file.messageId ? await fetchBlob((await call('/api/mail/attachment', { mailbox: file.mailbox, id: file.messageId, part: file.id })).url, file.type) : null);
      if (!blob) throw new Error(`Reattach ${file.name}; its upload is missing.`);
      const digest = await sha(await blob.arrayBuffer());
      const ticket = await call('/api/mail/upload', { mailbox: draft.mailbox, sha256: digest, size: blob.size });
      const result = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: blob });
      if (!result.ok) throw new Error('An attachment upload failed. Your draft is still open.');
      stored = { key: ticket.key, sha256: digest }; uploads.set(file.id, stored);
    }
    wire.attachments.push({ id: file.id, name: file.name, type: file.type, size: file.size, inline: Boolean(file.inline), key: stored.key, sha256: stored.sha256, ...(file.inline ? { cid: `inbox-${file.id}` } : {}) });
  }
  if (wire.html && wire.attachments.some(file => file.inline)) {
    const doc = document.createElement('template'); doc.innerHTML = wire.html;
    for (const image of doc.content.querySelectorAll('img[data-file-id]')) if (wire.attachments.some(file => file.inline && file.id === image.dataset.fileId)) image.setAttribute('src', `cid:inbox-${image.dataset.fileId}`);
    wire.html = doc.innerHTML;
  }
  return wire;
}
async function decodeDraft(wire) {
  const draft = { ...wire, attachments: [] };
  for (const file of wire.attachments || []) {
    uploads.set(file.id, { key: file.key, sha256: file.sha256 });
    const record = { id: file.id, name: file.name, type: file.type, size: file.size, inline: file.inline, key: file.key, sha256: file.sha256 };
    if (file.inline) record.blob = await fetchBlob((await call('/api/mail/upload/download', { mailbox: wire.mailbox, key: file.key })).url, file.type);
    draft.attachments.push(record);
  }
  if (draft.html && draft.attachments.some(file => file.blob)) {
    const doc = document.createElement('template'); doc.innerHTML = draft.html;
    for (const image of doc.content.querySelectorAll('img[data-file-id]')) { const file = draft.attachments.find(item => item.id === image.dataset.fileId && item.blob); if (file) image.setAttribute('src', await dataUrl(file.blob)); }
    draft.html = doc.innerHTML;
  }
  return draft;
}

export async function loadState() {
  if (dirty) throw new Error('Some changes are still being saved. Try again in a moment.');
  const [aliases, { entries, truncated }] = await Promise.all([call('/api/mail/mailboxes'), call('/api/mail/entries')]);
  const domains = new Map();
  for (const alias of aliases) {
    if (!domains.has(alias.domain)) domains.set(alias.domain, { id: alias.domain, name: alias.domainLabel, initial: alias.domainLabel.slice(0, 1).toUpperCase(), color: COLORS[alias.domain] || '#426859', aliases: [] });
    domains.get(alias.domain).aliases.push({ id: alias.address, address: alias.address, name: alias.name, enabled: alias.sendEnabled, receiveEnabled: alias.receiveEnabled, captured: !alias.receiveEnabled && !alias.sendEnabled, default: alias.default, signature: alias.signature });
  }
  const messages = new Map();
  for (const entry of entries) {
    const key = `${entry.domain}\u0000${entry.id}`;
    if (!messages.has(key)) messages.set(key, { id: entry.id, domain: entry.domain, thread: entry.thread, fromName: entry.fromName || entry.from, from: entry.from, to: entry.to, cc: entry.cc, subject: entry.subject || '(No subject)', text: entry.snippet, html: '', date: entry.date,
      source: entry.source, environment: entry.environment, hasAttachments: entry.hasAttachments, quarantined: entry.quarantined, attachments: [], mailboxes: {}, loaded: false });
    messages.get(key).mailboxes[entry.mailbox] = { folder: entry.folder, read: entry.read };
  }
  const drafts = [];
  draftBaseline = new Map();
  for (const alias of aliases.filter(item => item.sendEnabled)) {
    for (const item of await call('/api/mail/drafts', { mailbox: alias.address })) {
      const { revision, draft } = await call('/api/mail/draft', { mailbox: alias.address, id: item.id });
      const decoded = await decodeDraft({ ...draft, id: item.id, domain: alias.domain, mailbox: alias.address, aliasId: alias.address, updatedAt: item.updatedAt });
      drafts.push(decoded); draftBaseline.set(item.id, { revision, mailbox: alias.address, text: JSON.stringify(await encodeDraft(decoded)) });
    }
  }
  let navigation, preferences;
  try { navigation = JSON.parse(sessionStorage.getItem('inbox-navigation') || '{}'); } catch { navigation = {}; }
  try { preferences = { ...PREFERENCES, ...JSON.parse(localStorage.getItem('inbox-preferences') || '{}') }; } catch { preferences = { ...PREFERENCES }; }
  const state = { schema: 1, domains: [...domains.values()], messages: [...messages.values()], drafts, deleted: [], preferences,
    selectedDomain: domains.has(navigation.selectedDomain) ? navigation.selectedDomain : [...domains.keys()][0], selectedMailboxes: navigation.selectedMailboxes || {} };
  entryBaseline = entrySnapshot(state.messages);
  if (truncated) window.dispatchEvent(new CustomEvent('inbox:storage-error', { detail: new Error('Showing the newest 5,000 messages. Use search to find older mail.') }));
  return state;
}

// Folder and read changes become state calls; entries removed from Trash become deletions.
export async function persistState(state) {
  try { sessionStorage.setItem('inbox-navigation', JSON.stringify({ selectedDomain: state.selectedDomain, selectedMailboxes: state.selectedMailboxes })); localStorage.setItem('inbox-preferences', JSON.stringify(state.preferences)); } catch { /* Optional conveniences. */ }
  dirty = true;
  const current = entrySnapshot(state.messages), changes = new Map(), deletions = new Map();
  for (const [key, entry] of current) {
    const before = entryBaseline.get(key);
    if (!before) throw new Error('New mail can only be added by sending it.');
    if (before.folder === entry.folder && before.read === entry.read) continue;
    const [, id, address] = key.split('\u0000'), group = `${address}\u0000${entry.folder}\u0000${entry.read}`;
    if (!changes.has(group)) changes.set(group, { mailbox: address, folder: entry.folder, read: entry.read, ids: [], keys: [] });
    changes.get(group).ids.push(id); changes.get(group).keys.push(key);
  }
  for (const key of entryBaseline.keys()) if (!current.has(key)) {
    const [, id, address] = key.split('\u0000');
    if (!deletions.has(address)) deletions.set(address, { ids: [], keys: [] });
    deletions.get(address).ids.push(id); deletions.get(address).keys.push(key);
  }
  for (const change of changes.values()) {
    await call('/api/mail/state', { mailbox: change.mailbox, ids: change.ids, folder: change.folder, read: change.read });
    for (const key of change.keys) entryBaseline.set(key, current.get(key));
  }
  for (const [mailbox, deletion] of deletions) {
    await call('/api/mail/delete', { mailbox, ids: deletion.ids });
    for (const key of deletion.keys) entryBaseline.delete(key);
  }
  for (const draft of state.drafts) {
    const wire = await encodeDraft(draft), text = JSON.stringify(wire), before = draftBaseline.get(draft.id);
    if (before?.text === text) continue;
    const { id, domain, aliasId, mailbox, updatedAt, ...content } = wire;
    const saved = await call('/api/mail/draft/save', { mailbox, id, revision: before?.revision || 0, draft: content });
    draftBaseline.set(draft.id, { revision: saved.revision, mailbox, text });
  }
  const live = new Set(state.drafts.map(draft => draft.id));
  for (const [id, { mailbox }] of draftBaseline) if (!live.has(id)) {
    await call('/api/mail/draft/delete', { mailbox, id });
    draftBaseline.delete(id);
  }
  dirty = false;
}

// Bodies, attachments and inline images load only when a conversation is opened.
export async function loadConversation(state, domain, thread, address) {
  const messages = await call('/api/mail/thread', { mailbox: address, thread });
  for (const full of messages) {
    const target = state.messages.find(item => item.domain === domain && item.id === full.id);
    if (!target) continue;
    let html = full.html, inlineBytes = 0;
    if (html && !full.quarantined) {
      for (const part of full.attachments.filter(file => file.inline && file.cid && html.includes(`cid:${file.cid}`))) {
        if ((inlineBytes += part.size) > INLINE_LIMIT) break;
        const link = await call('/api/mail/attachment', { mailbox: address, id: full.id, part: part.id });
        html = html.replaceAll(`cid:${part.cid}`, await dataUrl(await fetchBlob(link.url, part.type)));
      }
    }
    Object.assign(target, { text: full.text, html, bcc: full.bcc, delivery: full.delivery, replyTo: full.replyTo?.[0]?.address, loaded: true,
      attachments: full.attachments.map(file => ({ ...file, messageId: full.id, mailbox: address })) });
  }
}

export async function searchMail(address, query) {
  return new Set((await call('/api/mail/search', { mailbox: address, query })).ids);
}

export async function attachmentUrl(file) {
  return (await call('/api/mail/attachment', { mailbox: file.mailbox, id: file.messageId, part: file.id })).url;
}

export const forwarding = {
  rules: mailbox => call('/api/mail/forwarding', { mailbox }),
  save: (mailbox, targets) => call('/api/mail/forwarding/save', { mailbox, targets }),
};

// Push notifications for this device. The browser subscription is enrolled with the server's
// VAPID key; the server id is kept locally so this device can turn itself off.
const DEVICE_KEY = 'inbox-push-device';
const keyBytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), char => char.charCodeAt(0));
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function deviceLabel() {
  const agent = navigator.userAgent, platform = /iPhone/.test(agent) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : 'Device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  return `${platform} · ${standalone() ? 'Home Screen app' : browser}`;
}
export const notifications = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  // iPhone and iPad allow web push only from the Home Screen app.
  needsHomeScreen: () => /iPhone|iPad|Macintosh.*Mobile/.test(navigator.userAgent) && navigator.maxTouchPoints > 0 && !standalone(),
  register: () => navigator.serviceWorker.register('/sw.js', { scope: '/' }),
  async status() {
    const supported = this.supported(), registration = supported ? await navigator.serviceWorker.getRegistration('/') : null;
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    let device = null; try { device = localStorage.getItem(DEVICE_KEY); } catch { /* optional */ }
    return { supported, permission: supported ? Notification.permission : 'unsupported', enrolled: Boolean(subscription && device), devices: await call('/api/push/devices'), device };
  },
  // Permission is requested first, while the click still counts as a user gesture.
  async enable() {
    if (!this.supported()) throw new Error('This browser cannot show notifications.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser or device settings.' : 'Notifications were not allowed.');
    const registration = await this.register(); await navigator.serviceWorker.ready;
    const { publicKey } = await call('/api/push/key'), key = keyBytes(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    const current = subscription?.options?.applicationServerKey && new Uint8Array(subscription.options.applicationServerKey);
    if (subscription && current && (current.length !== key.length || current.some((byte, i) => byte !== key[i]))) { await subscription.unsubscribe(); subscription = null; }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { id } = await call('/api/push/subscribe', { subscription: subscription.toJSON(), label: deviceLabel() });
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* optional */ }
  },
  async disable() {
    let device = null; try { device = localStorage.getItem(DEVICE_KEY); localStorage.removeItem(DEVICE_KEY); } catch { /* optional */ }
    if (device) await call('/api/push/remove', { id: device });
    const registration = await navigator.serviceWorker.getRegistration('/');
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  },
  remove: id => call('/api/push/remove', { id }),
  test: () => call('/api/push/test'),
};

// attemptId lives on the composer, so pressing Send again after an error never sends twice.
export async function sendDraft(composer) {
  const wire = await encodeDraft(composer);
  const result = await call('/api/mail/send', {
    mailbox: composer.mailbox, attemptId: composer.attemptId, draftId: draftBaseline.has(composer.id) ? composer.id : undefined,
    to: parseRecipients(composer.to), cc: parseRecipients(composer.cc), bcc: parseRecipients(composer.bcc), subject: composer.subject, text: composer.text, html: wire.html,
    attachments: wire.attachments.map(({ key, name, type, size, sha256, inline, cid }) => ({ key, name, type, size, sha256, inline, cid })), replyToId: composer.replyToId,
  });
  if (result.state === 'failed') throw new Error(`Not sent: ${result.detail || 'Amazon SES rejected this message.'}`);
  draftBaseline.delete(composer.id);
  return result;
}

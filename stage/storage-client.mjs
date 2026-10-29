// Replaces local-db.mjs only in the hosted shared-sample release.
export const sharedStorage = true;
let revision = 0, baseline, dirty = false, recoveryId, lastAttempt;
const files = new Map(), uploaded = new Map();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
export const hasUnsavedChanges = () => dirty;
let recoveryDatabase;
function recoveryDb() {
  return recoveryDatabase ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('project-inbox-stage-recovery-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recovery');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Local recovery storage is unavailable'));
  });
}
async function recovery(action, value) {
  const db = await recoveryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recovery', action === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('recovery');
    const request = action === 'get' ? store.get('pending') : action === 'put' ? store.put(value, 'pending') : store.delete('pending');
    tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(new Error('The browser could not retain your unsaved copy'));
  });
}
function dataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
async function exportable(value) {
  if (value instanceof Blob) return { blobDataUrl: await dataUrl(value) };
  if (Array.isArray(value)) return Promise.all(value.map(exportable));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await exportable(child)])));
  return value;
}
export function storageActions(notice) {
  const download = document.createElement('button'); download.className = 'text-button'; download.textContent = 'Download unsaved copy';
  download.onclick = async () => {
    try {
      const saved = await recovery('get'); if (!saved) throw new Error('No unsaved recovery copy is available');
      const blob = new Blob([JSON.stringify(await exportable(saved), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'inbox-unsaved-copy.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { alert(error.message); }
  };
  const reload = document.createElement('button'); reload.className = 'text-button'; reload.textContent = 'Use shared version';
  reload.onclick = async () => { if (confirm('Discard this browser’s unsaved changes and use the shared version? Download your unsaved copy first if you need it.')) { await recovery('delete'); dirty = false; window.dispatchEvent(new Event('inbox:discard-unsaved')); location.reload(); } };
  notice.append(document.createTextNode(' '), download, reload);
}
async function request(path, method = 'GET', value) {
  const headers = {}, options = { method, cache: 'no-store', credentials: 'same-origin', headers };
  if (method !== 'GET') {
    const session = await fetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!session.ok) throw new Error('Sign in again to save. Your unsaved copy is retained in this browser.');
    options.body = JSON.stringify(value);
    headers['content-type'] = 'application/json'; headers['x-inbox-csrf'] = (await session.json()).csrf;
    headers['x-amz-content-sha256'] = await sha(new TextEncoder().encode(options.body));
  }
  const response = await fetch(path, options), result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Shared workspace unavailable'); error.status = response.status; throw error; }
  return result;
}
const records = state => [...state.messages, ...state.drafts];
async function encode(state) {
  const wire = structuredClone(state); delete wire.selectedDomain; delete wire.selectedMailboxes;
  for (const record of records(wire)) {
    for (const file of record.attachments || []) {
      if (file.blob && !file.objectKey) {
        const digest = await sha(await file.blob.arrayBuffer());
        if (!uploaded.has(digest)) {
          const ticket = await request('/api/files/upload', 'POST', { sha256: digest, size: file.blob.size });
          const result = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file.blob });
          if (!result.ok) throw new Error('Attachment upload failed. Your draft is kept in this browser.');
          uploaded.set(digest, ticket.objectKey);
        }
        file.objectKey = uploaded.get(digest); file.sha256 = digest; files.set(file.objectKey, file.blob);
      }
      delete file.blob;
    }
    if (record.html && record.attachments?.some(file => file.inline && file.objectKey)) {
      const doc = document.createElement('template'); doc.innerHTML = record.html;
      for (const image of doc.content.querySelectorAll('img[data-file-id]')) {
        const file = record.attachments.find(file => file.id === image.dataset.fileId && file.inline && file.objectKey);
        if (file) image.setAttribute('src', `cid:inbox-${file.id}`);
      }
      record.html = doc.innerHTML;
    }
  }
  return wire;
}
async function decode(wire) {
  for (const record of records(wire)) {
    for (const file of record.attachments || []) if (file.objectKey) {
      if (!files.has(file.objectKey)) {
        const ticket = await request('/api/files/download', 'POST', { objectKey: file.objectKey });
        const response = await fetch(ticket.url); if (!response.ok) throw new Error('An attachment could not be downloaded');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== file.size || await sha(bytes) !== file.sha256) throw new Error('An attachment failed its integrity check');
        files.set(file.objectKey, new Blob([bytes], { type: file.type }));
      }
      file.blob = files.get(file.objectKey);
    }
    if (record.html && record.attachments?.some(file => file.inline && file.blob)) {
      const doc = document.createElement('template'); doc.innerHTML = record.html;
      for (const image of doc.content.querySelectorAll('img[data-file-id]')) {
        const file = record.attachments.find(file => file.id === image.dataset.fileId && file.inline && file.blob);
        if (file) image.setAttribute('src', await dataUrl(file.blob));
      }
      record.html = doc.innerHTML;
    }
  }
  let navigation; try { navigation = JSON.parse(sessionStorage.getItem('inbox-stage-navigation') || '{}'); } catch { navigation = {}; }
  return { ...wire, selectedDomain: wire.domains.some(domain => domain.id === navigation.selectedDomain) ? navigation.selectedDomain : wire.domains[0].id, selectedMailboxes: navigation.selectedMailboxes || {} };
}
export async function loadState() {
  if (dirty) throw new Error('There are unsaved changes. Download your copy before reloading the shared workspace.');
  const saved = await recovery('get').catch(() => null);
  if (saved) window.dispatchEvent(new CustomEvent('inbox:storage-error', { detail: new Error('An unsaved recovery copy from this browser is available to download.') }));
  const head = await request('/api/state');
  let wire = head.state;
  if (wire && head.digest && await sha(new TextEncoder().encode(JSON.stringify(wire))) !== head.digest) throw new Error('Shared mail failed its integrity check');
  if (head.url) {
    const result = await fetch(head.url); if (!result.ok) throw new Error('Shared mail could not be loaded');
    const bytes = await result.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024 || await sha(bytes) !== head.digest) throw new Error('Shared mail failed its integrity check');
    wire = JSON.parse(new TextDecoder().decode(bytes));
  }
  const state = await decode(wire);
  revision = head.revision; baseline = JSON.stringify(await encode(state));
  if (revision === 0) {
    baseline = undefined;
    try { await persistState(state); } catch (error) {
      if (error.status !== 409) throw error;
      await recovery('delete'); recoveryId = undefined; dirty = false; return loadState(); // Only initialization: no user edits exist yet.
    }
  }
  return state;
}
export async function persistState(state) {
  try { sessionStorage.setItem('inbox-stage-navigation', JSON.stringify({ selectedDomain: state.selectedDomain, selectedMailboxes: state.selectedMailboxes })); } catch { /* Navigation preferences are optional. */ }
  dirty = true;
  const existing = await recovery('get');
  // Preserve an older unrecovered draft instead of silently replacing it.
  if (existing && existing.id !== recoveryId) throw new Error('Download the existing unsaved copy, then clear it before saving new changes.');
  recoveryId ||= crypto.randomUUID(); await recovery('put', { id: recoveryId, at: new Date().toISOString(), state });
  const wire = await encode(state), text = JSON.stringify(wire);
  if (text === baseline) { await recovery('delete'); recoveryId = undefined; dirty = false; return; }
  if (!lastAttempt || lastAttempt.text !== text) lastAttempt = { text, writeId: crypto.randomUUID() };
  let result;
  try { result = await request('/api/state', 'PUT', { revision, writeId: lastAttempt.writeId, state: wire }); }
  catch (error) { if (error.status === 409 && error.message.includes('attachment was retired')) uploaded.clear(); throw error; }
  revision = result.revision; baseline = text; dirty = false; lastAttempt = undefined;
  const pending = await recovery('get'); if (pending?.id === recoveryId) await recovery('delete'); recoveryId = undefined;
}

// Real-mail hooks (web/live-mail.mjs); this storage has no live mail.
export const liveMail = false;
export async function loadConversation() {}
export async function searchMail() { return null; }
export async function attachmentUrl() { return null; }
export async function sendDraft() { throw new Error('Sending is not available in this preview.'); }
// The sample stage has no forwarding or push enrollment.
export const forwarding = null;
export const notifications = null;

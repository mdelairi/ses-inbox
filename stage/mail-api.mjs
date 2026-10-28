import { createHash, randomUUID } from 'node:crypto';
import { seedState } from '../web/fixtures.mjs';
import { entries, entryKey, deletionChanges, withoutDeleted, fileKeys, retirement } from './retention.mjs';

export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
export class MailError extends Error {
  constructor(status, message) { super(message); this.status = status; this.name = 'MailError'; }
}
const requireThat = (value, message = 'Invalid sample workspace', status = 400) => { if (!value) throw new MailError(status, message); };
export function fileReferences(state) {
  return [...state.messages, ...state.drafts].flatMap(record => record.attachments || []).filter(file => file.objectKey);
}
export function validateState(state, owner) {
  requireThat(state?.schema === 1 && Array.isArray(state.domains) && state.domains.length === 2);
  requireThat(JSON.stringify(state).length <= MAX_STATE_BYTES, 'The sample workspace is too large', 413);
  const inspect = (value, depth = 0) => {
    requireThat(depth < 30);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      requireThat(!['__proto__', 'constructor', 'prototype', 'blob'].includes(key)); inspect(child, depth + 1);
    }
  };
  inspect(state);
  const domains = new Set();
  for (const domain of state.domains) {
    requireThat(['example.com', 'example.org'].includes(domain.id) && !domains.has(domain.id)); domains.add(domain.id);
    requireThat(Array.isArray(domain.aliases) && domain.aliases.length <= 100);
    const addresses = new Set(), ids = new Set();
    for (const alias of domain.aliases) {
      requireThat(typeof alias.id === 'string' && alias.id.length <= 100 && !ids.has(alias.id)); ids.add(alias.id);
      requireThat(typeof alias.address === 'string' && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(alias.address) && alias.address.endsWith(`@${domain.id}`) && !addresses.has(alias.address)); addresses.add(alias.address);
      requireThat(typeof alias.name === 'string' && alias.name.length <= 200 && typeof alias.enabled === 'boolean');
    }
  }
  for (const key of ['messages', 'drafts', 'deleted']) requireThat(Array.isArray(state[key]) && state[key].length <= 1000);
  let bytes = 0; const objects = new Set();
  for (const [kind, records] of [['messages', state.messages], ['drafts', state.drafts]]) {
    const ids = new Set();
    for (const record of records) {
      requireThat(typeof record.id === 'string' && record.id.length <= 100 && !ids.has(record.id)); ids.add(record.id);
      requireThat(domains.has(record.domain) && typeof record.text === 'string' && typeof record.html === 'string' && typeof record.subject === 'string');
      requireThat(record.subject.length <= 998 && !/[\r\n]/.test(record.subject));
      if (kind === 'drafts') {
        const alias = state.domains.find(domain => domain.id === record.domain).aliases.find(alias => alias.id === record.aliasId);
        requireThat(alias && (!record.mailbox || record.mailbox === alias.address), 'Draft sender must match its mailbox');
      }
      if (record.mailboxes) for (const [address, entry] of Object.entries(record.mailboxes)) requireThat(address.endsWith(`@${record.domain}`) && ['inbox', 'sent', 'archive', 'trash', 'spam'].includes(entry.folder) && typeof entry.read === 'boolean');
      requireThat(Array.isArray(record.attachments) && record.attachments.length <= 10);
      let recordBytes = 0;
      for (const file of record.attachments) {
        requireThat(typeof file.id === 'string' && typeof file.name === 'string' && file.name.length <= 255 && typeof file.type === 'string');
        requireThat(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES); recordBytes += file.size;
        if (file.objectKey) {
          requireThat(new RegExp(`^samples/${owner}/files/(?:[a-f0-9-]{36}/)?[a-f0-9]{64}$`).test(file.objectKey) && file.sha256 === file.objectKey.split('/').at(-1));
          if (!objects.has(file.objectKey)) { objects.add(file.objectKey); bytes += file.size; }
        } else requireThat(typeof file.content === 'string' && file.content.length < 100000, 'Attachment must be uploaded first');
      }
      requireThat(recordBytes <= 20 * 1024 * 1024, 'Use at most 20 MB of files per message');
    }
  }
  requireThat(bytes <= 100 * 1024 * 1024, 'The shared sample workspace supports up to 100 MB of attached files', 413);
  return state;
}

// Stage-only versioned workspace: immutable S3 state/files and a small DSQL CAS head.
// This is deliberately separate from the eventual relational real-mail repository.
export function createMailApi({ heads, objects, now = Date.now }) {
  async function current(owner) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await heads.get(owner);
      if (!head) return {};
      try {
        const text = await objects.read(head.objectKey);
        if (digest(text) !== head.digest) throw new Error('SampleStateIntegrityFailure');
        return { head, state: withoutDeleted(JSON.parse(text), await heads.tombstones(owner)) };
      } catch (error) {
        // A concurrent writer can retire this immutable key after we read its
        // head. Retry from the head, never return a mismatched revision/body.
        // Without ListBucket permission, S3 can report a retired key as 403.
        // Retry only if the revision pointer actually changed; do not mask real
        // permission or integrity failures against the current object.
        if (attempt === 2 || (await heads.get(owner))?.objectKey === head.objectKey) throw error;
      }
    }
  }
  return async ({ method, path, body, sub }) => {
    const owner = digest(sub);
    if (path === '/api/files/upload' && method === 'POST') {
      requireThat(await heads.get(owner), 'Load the shared workspace before uploading files.', 409);
      requireThat(/^[a-f0-9]{64}$/.test(body?.sha256 || '') && Number.isSafeInteger(body.size) && body.size >= 0 && body.size <= MAX_FILE_BYTES, 'Use a file up to 10 MB');
      const key = `samples/${owner}/files/${randomUUID()}/${body.sha256}`;
      return { status: 200, data: { objectKey: key, ...(await objects.uploadUrl(key, body.sha256, body.size)) } };
    }
    if (path === '/api/files/download' && method === 'POST') {
      const snapshot = await current(owner); requireThat(snapshot.head, 'Workspace not found', 404);
      const file = fileReferences(snapshot.state).find(file => file.objectKey === body?.objectKey);
      requireThat(file, 'File is no longer in this workspace', 404);
      return { status: 200, data: { url: await objects.downloadUrl(file.objectKey), sha256: file.sha256 } };
    }
    if (path !== '/api/state') return { status: 404, data: { error: 'Live email delivery is not connected' } };
    if (method === 'GET') {
      const snapshot = await current(owner), head = snapshot.head;
      return { status: 200, data: head ? { revision: head.revision, digest: digest(JSON.stringify(snapshot.state)), state: snapshot.state } : { revision: 0, state: withoutDeleted(seedState(), await heads.tombstones(owner)) } };
    }
    requireThat(method === 'PUT', 'Method not allowed', 405);
    requireThat(Number.isSafeInteger(body?.revision) && body.revision >= 0 && /^[a-zA-Z0-9-]{16,80}$/.test(body.writeId || ''));
    validateState(body.state, owner);
    const text = JSON.stringify(body.state), sha = digest(text);
    requireThat(Buffer.byteLength(text) <= MAX_STATE_BYTES, 'The sample workspace is too large', 413);
    const snapshot = await current(owner), previous = snapshot.head;
    if (previous?.writeId === body.writeId && previous.digest === sha) return { status: 200, data: { revision: previous.revision } };
    requireThat((previous?.revision || 0) === body.revision, 'Newer changes were saved on another device. Your unsaved copy is kept in this browser.', 409);
    const blocked = new Set((await heads.tombstones(owner)).map(entryKey));
    requireThat(!entries(body.state).some(entry => blocked.has(entryKey(entry))), 'This copy includes permanently deleted mail. Reload the shared workspace.', 409);
    const candidates = new Map(fileReferences(body.state).map(file => [file.objectKey, file]));
    const retiredFiles = candidates.size ? new Set((await heads.retired(owner)).map(item => item.objectKey)) : new Set();
    for (const file of candidates.values()) {
      requireThat(!retiredFiles.has(file.objectKey), 'An attachment was retired. Reattach its file before saving.', 409);
      const stored = await objects.head(file.objectKey);
      requireThat(stored.size === file.size && stored.sha256 === file.sha256, 'An attachment upload is incomplete');
    }
    const key = `samples/${owner}/states/${randomUUID()}.json`;
    const next = { objectKey: key, digest: sha, revision: body.revision + 1, writeId: body.writeId };
    // An unknown commit outcome must leave the object intact: it may be live.
    const retainedFiles = fileKeys(body.state), oldFiles = snapshot.state ? fileKeys(snapshot.state) : new Set();
    const changes = {
      deletions: snapshot.state ? deletionChanges(snapshot.state, body.state) : [], candidateEntries: entries(body.state), candidateFiles: [...retainedFiles],
      retirements: [...(previous ? [{ ...retirement(previous.objectKey, 'state', now()), digest: previous.digest }] : []), ...[...oldFiles].filter(key => !retainedFiles.has(key)).map(key => retirement(key, 'file', now()))],
      at: new Date(now()).toISOString(),
    };
    requireThat(changes.deletions.length + changes.retirements.length <= 2000, 'Make this change in smaller batches.', 413);
    await objects.write(key, text);
    const accepted = await heads.compareAndSwap(owner, body.revision, next, changes);
    if (!accepted) { await objects.remove(key).catch(() => {}); throw new MailError(409, 'Another device saved first. Your unsaved copy is kept in this browser.'); }
    // Deleting an old immutable key makes its version noncurrent. Never expire the live head.
    if (previous) await objects.remove(previous.objectKey).catch(() => {});
    return { status: 200, data: { revision: next.revision } };
  };
}

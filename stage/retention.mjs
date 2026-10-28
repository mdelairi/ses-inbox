import { createHash } from 'node:crypto';
import { mailboxEntries } from '../web/model.mjs';

export const DAY = 86400000;
export const RECOVERY_DAYS = 29;
export const ORPHAN_GRACE_MS = DAY;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const entryKey = entry => hash(JSON.stringify([entry.kind, entry.domain, entry.id, entry.mailbox]));
export const recordKey = record => JSON.stringify([record.domain, record.id]);
export const fileKeys = state => new Set([...state.messages, ...state.drafts].flatMap(record => record.attachments || []).filter(file => file.objectKey).map(file => file.objectKey));
export const scopedKey = (owner, key) => /^[a-f0-9]{64}$/.test(owner) && key.startsWith(`samples/${owner}/`) && !key.includes('..');
export function entries(state) {
  return [
    ...state.messages.flatMap(message => Object.keys(mailboxEntries(message)).map(mailbox => ({ kind: 'message', domain: message.domain, id: message.id, mailbox }))),
    ...state.drafts.map(draft => ({ kind: 'draft', domain: draft.domain, id: draft.id, mailbox: draft.mailbox || state.domains.find(domain => domain.id === draft.domain)?.aliases.find(alias => alias.id === draft.aliasId)?.address || '' })),
  ];
}
export function deletionChanges(before, after) {
  const retained = new Set(entries(after).map(entryKey));
  return entries(before).filter(entry => !retained.has(entryKey(entry)));
}
export function withoutDeleted(state, tombstones) {
  const blocked = new Set(tombstones.map(entryKey)), result = structuredClone(state);
  result.messages = result.messages.flatMap(message => {
    message.mailboxes = Object.fromEntries(Object.entries(mailboxEntries(message)).filter(([mailbox]) => !blocked.has(entryKey({ kind: 'message', domain: message.domain, id: message.id, mailbox }))));
    return Object.keys(message.mailboxes).length ? [message] : [];
  });
  const draftEntries = new Map(entries(state).filter(entry => entry.kind === 'draft').map(entry => [recordKey(entry), entry]));
  result.drafts = result.drafts.filter(draft => !blocked.has(entryKey(draftEntries.get(recordKey(draft)))));
  return result;
}
export function mergeMissing(current, recovered) {
  const merged = structuredClone(current);
  let messages = 0, drafts = 0, mailboxCopies = 0;
  for (const domain of recovered.domains) {
    const target = merged.domains.find(item => item.id === domain.id);
    if (!target) throw new Error('Unknown recovery domain');
    for (const alias of domain.aliases) if (!target.aliases.some(item => item.id === alias.id || item.address === alias.address)) target.aliases.push({ ...alias, enabled: false, default: false });
  }
  for (const message of recovered.messages) {
    const existing = merged.messages.find(item => recordKey(item) === recordKey(message));
    if (!existing) { merged.messages.push(structuredClone(message)); messages++; }
    else {
      existing.mailboxes = mailboxEntries(existing);
      for (const [mailbox, entry] of Object.entries(mailboxEntries(message))) if (!existing.mailboxes[mailbox]) { existing.mailboxes[mailbox] = structuredClone(entry); mailboxCopies++; }
    }
  }
  for (const draft of recovered.drafts) if (!merged.drafts.some(item => recordKey(item) === recordKey(draft))) { merged.drafts.push(structuredClone(draft)); drafts++; }
  return { state: merged, added: { messages, drafts, mailboxCopies } };
}
export function retirement(key, kind, now) {
  return { objectKey: key, kind, retiredAt: new Date(now).toISOString(), purgeAfter: new Date(now + RECOVERY_DAYS * DAY).toISOString() };
}

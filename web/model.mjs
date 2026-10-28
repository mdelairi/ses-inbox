export const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const domainOf = (state, id) => state.domains.find(domain => domain.id === id);
export const aliasesOf = (state, id) => domainOf(state, id)?.aliases || [];
export const defaultAlias = (state, id) => aliasesOf(state, id).find(alias => alias.enabled && alias.default) || aliasesOf(state, id).find(alias => alias.enabled);
// Each address owns its folder/read state, even when one message reaches two aliases.
export function mailboxEntries(message) {
  if (message.mailboxes) return message.mailboxes;
  const own = address => address?.toLowerCase().endsWith(`@${message.domain}`);
  const addresses = own(message.from) ? [message.from] : [...(message.envelopeTo || message.to || []), ...(message.cc || []), ...(message.bcc || [])].filter(own);
  return Object.fromEntries([...new Set(addresses.map(address => address.toLowerCase()))].map(address => [address, { folder: message.folder, read: message.read, previousFolder: message.previousFolder }]));
}
export function inMailbox(message, address) { return Boolean(address && mailboxEntries(message)[address]); }
export function setMailboxState(message, address, patch) {
  message.mailboxes ||= mailboxEntries(message);
  if (message.mailboxes[address]) Object.assign(message.mailboxes[address], patch);
}
export function mailboxesOf(state, domain) {
  const aliases = aliasesOf(state, domain);
  const observed = new Set(state.messages.filter(message => message.domain === domain).flatMap(message => Object.keys(mailboxEntries(message))));
  return [...aliases, ...[...observed].filter(address => !aliases.some(alias => alias.address === address)).sort().map(address => ({ id: address, address, name: 'Captured project mail', enabled: false, captured: true }))];
}
export function selectedMailbox(state) {
  const options = mailboxesOf(state, state.selectedDomain);
  return options.find(alias => alias.address === state.selectedMailboxes?.[state.selectedDomain]) || options.find(alias => alias.default && alias.enabled) || options[0];
}
export function normalize(value) { return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function words(value) { return normalize(value).split(/\s+/).filter(Boolean); }
export function searchable(message) { return [message.fromName, message.from, ...(message.to || []), ...(message.cc || []), message.subject, message.text].join('\n'); }
export function createSearchIndex(messages) {
  const terms = new Map(), documents = new Map();
  for (const message of messages) {
    const key = `${message.domain}\u0000${message.id}`, text = normalize(searchable(message));
    documents.set(key, text);
    for (const word of new Set(words(text))) {
      const term = `${message.domain}\u0000${word}`;
      if (!terms.has(term)) terms.set(term, new Set());
      terms.get(term).add(message.id);
    }
  }
  return { terms, documents };
}
export function searchIds(index, domain, query) {
  // Live mail: ids come from the server search for the selected mailbox; null means no query.
  if (index.remote) { const key = query.trim(); return key ? index.remote.get(key) || new Set() : null; }
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map(match => normalize(match[1])).filter(Boolean);
  const tokens = words(query);
  if (!tokens.length) return null;
  const postings = tokens.map(token => index.terms.get(`${domain}\u0000${token}`) || new Set()).sort((a, b) => a.size - b.size);
  return new Set([...postings[0]].filter(id => postings.every(set => set.has(id)) && phrases.every(phrase => ` ${index.documents.get(`${domain}\u0000${id}`)} `.includes(` ${phrase} `))));
}
export function visibleThreads(state, { domain, folder = 'inbox', query = '', alias = '', source = '', environment = '', unread = false }, index = createSearchIndex(state.messages)) {
  const found = searchIds(index, domain, query), groups = new Map();
  for (const original of state.messages) {
    if (alias && !inMailbox(original, alias)) continue;
    const message = alias ? { ...original, ...mailboxEntries(original)[alias] } : original;
    if (message.domain !== domain || (!query.trim() && message.folder !== folder) || (found && !found.has(message.id))) continue;
    if (source && message.source !== source || environment && message.environment !== environment || unread && message.read) continue;
    if (!groups.has(message.thread)) groups.set(message.thread, []);
    groups.get(message.thread).push(message);
  }
  return [...groups].map(([id, matching]) => ({ id, matching, latest: [...matching].sort((a, b) => b.date.localeCompare(a.date))[0], unread: matching.some(message => !message.read) })).sort((a, b) => b.latest.date.localeCompare(a.latest.date));
}
export function conversation(state, domain, thread, alias = '') { return state.messages.filter(message => message.domain === domain && message.thread === thread && (!alias || inMailbox(message, alias))).map(message => alias ? { ...message, ...mailboxEntries(message)[alias] } : message).sort((a, b) => a.date.localeCompare(b.date)); }
export function replyAlias(state, domain, message) {
  const enabled = aliasesOf(state, domain).filter(alias => alias.enabled);
  return enabled.find(alias => (message.to || []).includes(alias.address)) || enabled.find(alias => (message.cc || []).includes(alias.address)) || enabled.find(alias => alias.address === message.from) || defaultAlias(state, domain);
}
export function parseRecipients(value) {
  const recipients = [...new Set(String(value || '').split(/[,;\n]+/).map(address => address.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > 20 || recipients.some(address => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address))) throw new Error('Use valid email addresses, separated by commas (up to 20 per field).');
  return recipients;
}
export function validateDraft(state, draft) {
  const alias = aliasesOf(state, draft.domain).find(alias => alias.id === draft.aliasId && alias.enabled);
  if (!alias) throw new Error('Choose an enabled sender alias.');
  if (draft.mailbox && alias.address !== draft.mailbox) throw new Error('The sender must match this mailbox. Open the intended mailbox before composing.');
  const to = parseRecipients(draft.to), cc = parseRecipients(draft.cc), bcc = parseRecipients(draft.bcc);
  if (!to.length) throw new Error('Add at least one recipient.');
  if (to.length + cc.length + bcc.length > 50) throw new Error('Use at most 50 recipients.');
  if (/[\r\n]/.test(draft.subject) || draft.subject.length > 998) throw new Error('Use a subject under 999 characters without line breaks.');
  const attachments = draft.attachments || [];
  if (attachments.length > 10) throw new Error('Use at most 10 attachments.');
  if (attachments.some(file => file.size > MAX_FILE_BYTES) || attachments.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new Error('Use files up to 10 MB each and 20 MB combined.');
  return { alias, to, cc, bcc };
}
export function sendLocally(state, draft, now = new Date().toISOString()) {
  const { alias, to, cc, bcc } = validateDraft(state, draft);
  if (state.messages.some(message => message.id === draft.id)) throw new Error('This draft has already been sent locally.');
  const message = { id: draft.id, domain: draft.domain, thread: draft.thread || draft.id, fromName: alias.name, from: alias.address, to, cc, bcc, subject: draft.subject || '(No subject)', text: draft.text || '', html: draft.html || '', date: now, folder: 'sent', read: true, mailboxes: { [alias.address]: { folder: 'sent', read: true } }, source: 'manual', environment: 'production', status: 'local', attachments: structuredClone(draft.attachments || []) };
  state.messages.push(message);
  state.drafts = state.drafts.filter(item => item.id !== draft.id);
  return message;
}
export function moveMessages(state, domain, ids, folder, alias = '') {
  if (!FOLDERS.includes(folder) || folder === 'drafts') throw new Error('Choose a mail folder.');
  const affected = state.messages.filter(message => message.domain === domain && ids.includes(message.id) && (!alias || inMailbox(message, alias)));
  for (const message of affected) {
    if (alias) setMailboxState(message, alias, { previousFolder: mailboxEntries(message)[alias].folder, folder });
    else { message.previousFolder = message.folder; message.folder = folder; if (message.mailboxes) for (const entry of Object.values(message.mailboxes)) { entry.previousFolder = entry.folder; entry.folder = folder; } }
  }
  return affected;
}
export function permanentlyDelete(state, domain, ids, now = new Date().toISOString(), alias = '') {
  const affected = state.messages.filter(message => message.domain === domain && ids.includes(message.id) && (alias ? mailboxEntries(message)[alias]?.folder === 'trash' : message.folder === 'trash'));
  for (const message of affected) {
    state.deleted.push({ id: message.id, domain, ...(alias ? { mailbox: alias } : {}), deletedAt: now });
    if (alias) { message.mailboxes ||= mailboxEntries(message); delete message.mailboxes[alias]; }
  }
  const deleted = new Set(affected.map(message => message.id));
  state.messages = state.messages.filter(message => message.domain !== domain || !deleted.has(message.id) || (alias && Object.keys(mailboxEntries(message)).length));
  return affected;
}
export function saveAlias(state, domain, { id, address, name, enabled = true, makeDefault = false, signature = '', disableOld = false }) {
  const project = domainOf(state, domain);
  if (!project) throw new Error('Unknown domain.');
  address = String(address).trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(address.split('@')[0]) || address.split('@')[1] !== domain || address.split('@').length !== 2) throw new Error(`Use an address at ${domain}.`);
  if (!name.trim()) throw new Error('Add a sender display name.');
  const existing = project.aliases.find(alias => alias.id === id), renamed = existing && existing.address !== address;
  if (project.aliases.some(alias => alias.address === address && alias.id !== (renamed ? null : id))) throw new Error('That address already exists.');
  if (makeDefault && !enabled) throw new Error('The default sender must be enabled.');
  const record = { id: renamed || !existing ? crypto.randomUUID() : id, address, name: name.trim(), enabled, signature, default: makeDefault || Boolean(existing?.default && !renamed && enabled) };
  if (renamed || !existing) project.aliases.push(record); else Object.assign(existing, record);
  if (renamed && disableOld) { existing.enabled = false; existing.default = false; }
  if (record.default) for (const alias of project.aliases) if (alias.id !== record.id) alias.default = false;
  if (!project.aliases.some(alias => alias.default && alias.enabled)) { const fallback = project.aliases.find(alias => alias.enabled); if (fallback) fallback.default = true; }
  return record;
}

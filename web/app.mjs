import { seedState } from './fixtures.mjs';
import { FOLDERS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, domainOf, aliasesOf, defaultAlias, createSearchIndex, visibleThreads, conversation, mailboxEntries, inMailbox, setMailboxState, mailboxesOf, selectedMailbox, sendLocally, moveMessages, permanentlyDelete, saveAlias } from './model.mjs';
import { loadState, persistState, sharedStorage, hasUnsavedChanges, storageActions, liveMail, loadConversation, searchMail, attachmentUrl, sendDraft } from './local-db.mjs';
import { escapeHTML as esc, sanitizeHTML, safeLink, htmlText, messageDocument } from './safety.mjs';

const paths = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  inbox: '<path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  send: '<path d="m22 2-7 20-4-9L2 9l20-7Z"/><path d="m11 13 6-6"/>',
  drafts: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  archive: '<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  spam: '<path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6H8ZM12 7v6"/><path d="M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.8" cy="10.8" r="7"/><path d="m16 16 5 5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  settings: '<path d="m9 3-1 3-3 1v4l-2 2 2 3 3 1 1 4h6l1-4 3-1 2-3-2-2V7l-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  filter: '<path d="M3 5h18M6 12h12M9 19h6"/><circle cx="8" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 9M20 3v6h-6"/>',
  clip: '<path d="m21 11-8 8a6 6 0 0 1-8-8L15 2a4 4 0 0 1 6 6L10 18a2 2 0 0 1-3-3l9-9"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  reply: '<path d="m9 5-7 7 7 7M3 12h9c5 0 8 3 9 7v-5c0-5-3-7-8-7"/>',
  forward: '<path d="m15 5 7 7-7 7M21 12h-9c-5 0-8 3-9 7v-5c0-5 3-7 8-7"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 15-5-5-8 11M3 17l4-4 4 4"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  undo: '<path d="m9 4-6 6 6 6M3 10h11a7 7 0 0 1 0 14"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.mail}</svg>`;
const folderNames = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', spam: 'Spam' };
const folderIcons = { inbox: 'inbox', sent: 'send', drafts: 'drafts', archive: 'archive', trash: 'trash', spam: 'spam' };
const root = document.querySelector('#app');
const composeDialog = document.querySelector('#compose-dialog');
const settingsDialog = document.querySelector('#settings-dialog');
const aliasDialog = document.querySelector('#alias-dialog');
const confirmDialog = document.querySelector('#confirm-dialog');
let state, index, view = { folder: 'inbox', selected: null, query: '', alias: '', source: '', environment: '', unread: false, mobileSidebar: false, domainMenu: false, filters: false, more: false };
let composer = null, draftTimer, saveQueue = Promise.resolve(), settingsTab = 'aliases', settingsDomain, confirmCallback, lastRange, refreshing = false;
const remoteLoaded = new Set();
// Live mail searches on the server; results are cached per query for the selected mailbox.
const searchCache = new Map();
let searchTimer;
const uid = () => crypto.randomUUID();
const initials = name => String(name || '?').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const prettySize = size => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
function timeShort(date) { const value = new Date(date); return value.toDateString() === new Date().toDateString() ? value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : value.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function timeFull(date) { return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function buttons(name, title, action, extra = '') { return `<button class="icon-button" type="button" aria-label="${esc(title)}" title="${esc(title)}" data-action="${action}" ${extra}>${icon(name)}</button>`; }
function tags(message) { return `${message.source === 'automated' ? '<span class="tag automated">Automated</span>' : ''}${message.environment === 'staging' ? '<span class="tag staging">Staging</span>' : message.source === 'automated' ? '<span class="tag">Production</span>' : ''}${message.status === 'local' ? '<span class="tag local">Local preview</span>' : ''}${message.delivery ? `<span class="tag delivery-${esc(message.delivery.state)}" title="${esc(message.delivery.detail || '')}">${DELIVERY[message.delivery.state] || esc(message.delivery.state)}</span>` : ''}${message.quarantined ? '<span class="tag">Virus check failed</span>' : ''}`; }
const activeAddress = () => selectedMailbox(state)?.address || '';
const canCompose = () => Boolean(selectedMailbox(state)?.enabled);
const mailboxDrafts = () => state.drafts.filter(draft => draft.domain === state.selectedDomain && draft.aliasId === selectedMailbox(state)?.id);
function threads() { return visibleThreads(state, { ...view, domain: state.selectedDomain, alias: activeAddress() }, index); }
function selectedGroup() { return threads().find(group => group.id === view.selected); }
function currentConversation() { return view.selected ? conversation(state, state.selectedDomain, view.selected, activeAddress()) : []; }
function updateIndex() { index = liveMail ? { remote: searchCache } : createSearchIndex(state.messages); }
function scheduleSearch() {
  clearTimeout(searchTimer);
  const query = view.query.trim(), address = activeAddress();
  if (!liveMail || !query || searchCache.has(query)) return;
  searchTimer = setTimeout(async () => {
    try { searchCache.set(query, await searchMail(address, query)); } catch (error) { toast(error.message, { error: true }); return; }
    if (view.query.trim() === query && activeAddress() === address) render();
  }, 300);
}
const DELIVERY = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', delayed: 'Delayed', bounced: 'Bounced', complained: 'Complaint', rejected: 'Rejected', failed: 'Not sent', uncertain: 'Unconfirmed' };
function showStorageError(error) {
  const notice = document.querySelector('#storage-notice'); notice.hidden = false; notice.textContent = error.message;
  if (sharedStorage) {
    const composeError = composeDialog.open && document.querySelector('#compose-error');
    if (composeError) { composeError.hidden = false; composeError.textContent = error.message; storageActions(composeError); }
    else storageActions(notice);
  }
}
function toast(message, { undo, error = false } = {}) {
  const element = document.createElement('div'); element.className = `toast${error ? ' error' : ''}`;
  const text = document.createElement('span'); text.textContent = message; element.append(text);
  if (undo) { const button = document.createElement('button'); button.textContent = 'Undo'; button.addEventListener('click', async () => { await undo(); element.remove(); }); element.append(button); }
  document.querySelector('#toasts').append(element); setTimeout(() => element.remove(), undo ? 9000 : 5000);
}
async function commit({ reindex = false } = {}) {
  if (reindex) updateIndex();
  const snapshot = structuredClone(state);
  const pending = saveQueue.catch(() => {}).then(() => persistState(snapshot)); saveQueue = pending;
  try { await pending; return true; } catch (error) { showStorageError(error); toast('Changes are not saved. Please keep this tab open.', { error: true }); return false; }
}
function sidebarHTML() {
  const domain = domainOf(state, state.selectedDomain);
  return `<aside class="sidebar"><div class="brand"><span class="brand-symbol">${icon('mail')}</span><span>Inbox<small>PROJECT MAIL</small></span></div>
    <div class="domain-switch-wrap"><button class="domain-switch" aria-label="Switch domain: ${esc(domain.id)}" aria-expanded="${view.domainMenu}" data-action="toggle-domain"><span class="domain-monogram">${domain.initial}</span><span class="domain-meta"><small class="eyebrow">Workspace</small><strong>${esc(domain.id)}</strong></span><span class="chevron">${icon('chevron')}</span></button>
    ${view.domainMenu ? `<div class="domain-menu" role="group" aria-label="Choose domain">${state.domains.map(project => `<button class="domain-option" aria-label="${esc(project.id)}" data-action="switch-domain" data-domain="${esc(project.id)}"><span class="domain-monogram" style="color:${project.id === 'example.org' ? '#365f8c' : '#426859'}">${project.initial}</span><span>${esc(project.id)}</span>${project.id === domain.id ? icon('check') : ''}</button>`).join('')}</div>` : ''}</div>

    <button class="compose-button" data-action="compose" ${canCompose() ? '' : 'disabled'}>${icon('plus')}Compose</button><p class="nav-label">MAILBOX</p>
    <nav class="folder-nav" aria-label="Mail folders">${FOLDERS.map(folder => { const count = folder === 'drafts' ? mailboxDrafts().length : folder === 'inbox' ? state.messages.filter(message => message.domain === domain.id && mailboxEntries(message)[activeAddress()]?.folder === folder && !mailboxEntries(message)[activeAddress()].read).length : 0; return `<button class="folder-button${view.folder === folder && !view.query ? ' active' : ''}" data-action="folder" data-folder="${folder}" ${view.folder === folder && !view.query ? 'aria-current="page"' : ''}>${icon(folderIcons[folder])}<span>${folderNames[folder]}</span>${count ? `<b class="count">${count}</b>` : ''}</button>`; }).join('')}</nav>
    <div class="sidebar-spacer"></div><div class="mailbox-note">${canCompose() ? 'Compose and reply from' : 'Viewing mail for'}<strong>${esc(activeAddress())}</strong></div>
    <div class="sidebar-bottom"><button class="folder-button settings-button" data-action="settings">${icon('settings')}<span>Aliases & settings</span></button></div>
    <div class="profile"><span class="avatar">TE</span><span><strong>Taylor Example</strong><small>${liveMail ? 'Live mail' : 'Local prototype'}</small></span>${liveMail ? '' : '<span class="local-indicator" title="Sample data only"></span>'}</div></aside>`;
}
function topbarHTML() {
  return `<header class="topbar">${buttons('menu', 'Open navigation', 'toggle-sidebar', 'class="mobile-menu"').replace('class="icon-button"', 'class="icon-button mobile-menu"').replace(' class="mobile-menu"', '')}<div class="breadcrumb"><strong>${esc(domainOf(state, state.selectedDomain).name)}</strong><span class="breadcrumb-address">${esc(activeAddress())}</span>${icon('right')}<span>${view.query ? 'Search' : folderNames[view.folder]}</span></div>
    <label class="search-field">${icon('search')}<span class="sr-only">Search current mailbox</span><input id="mail-search" type="search" autocomplete="off" placeholder="Search ${esc(activeAddress())}" value="${esc(view.query)}">${view.query ? `<button class="search-clear" data-action="clear-search" type="button" aria-label="Clear search">${icon('close')}</button>` : '<span class="shortcut" aria-hidden="true">/</span>'}</label>
    ${liveMail ? '' : '<span class="preview-label"><span></span>Local prototype</span>'}${buttons('bell', 'Preview new-mail notification', 'preview-notification')}</header>`;
}
function filterHTML() {
  const active = view.source || view.environment;
  return `<div class="list-filterbar"><button class="view-toggle${!view.unread ? ' active' : ''}" data-action="show-all" aria-pressed="${!view.unread}">All mail</button><button class="view-toggle${view.unread ? ' active' : ''}" data-action="show-unread" aria-pressed="${view.unread}">Unread</button>
    <button class="filter-button${active ? ' active' : ''}" data-action="toggle-filters" aria-expanded="${view.filters}">${icon('filter')}Filters${active ? ' ·' : ''}</button>
    ${view.filters ? `<div class="filters-popover"><label>Source<select id="filter-source"><option value="">All sources</option><option value="manual" ${view.source === 'manual' ? 'selected' : ''}>People & manual mail</option><option value="automated" ${view.source === 'automated' ? 'selected' : ''}>Automated project mail</option></select></label><label>Environment<select id="filter-environment"><option value="">All environments</option><option value="production" ${view.environment === 'production' ? 'selected' : ''}>Production</option><option value="staging" ${view.environment === 'staging' ? 'selected' : ''}>Staging</option></select></label><button data-action="clear-filters">Clear filters</button></div>` : ''}</div>`;
}
function rowHTML(group) {
  const message = group.latest, count = conversation(state, state.selectedDomain, group.id, activeAddress()).length;
  const own = message.from.endsWith(`@${state.selectedDomain}`), address = own ? `To: ${message.to.join(', ')}` : (message.to || []).filter(to => to.endsWith(`@${state.selectedDomain}`)).join(', ');
  return `<button class="thread-row${view.selected === group.id ? ' selected' : ''}${group.unread ? ' unread' : ''}" data-action="open-thread" data-thread="${esc(group.id)}" aria-label="Open ${esc(message.subject)}" ${view.selected === group.id ? 'aria-current="true"' : ''}>${group.unread ? '<span class="unread-dot"></span>' : ''}<span class="row-head"><strong>${esc(own && message.source !== 'automated' ? 'You' : message.fromName)}</strong><time datetime="${message.date}">${timeShort(message.date)}</time></span><div class="row-subject">${esc(message.subject)}${count > 1 ? `<span class="thread-count">${count}</span>` : ''}</div><p class="row-snippet">${esc(message.text.replace(/\s+/g, ' '))}</p><div class="row-foot"><span class="row-alias">${esc(address)}</span>${tags(message)}${message.attachments?.length || message.hasAttachments ? icon('clip') : ''}</div></button>`;
}
function draftRowHTML(draft) { return `<button class="thread-row draft-row" data-action="resume-draft" data-id="${esc(draft.id)}" aria-label="Resume draft: ${esc(draft.subject || 'New message')}"><span class="row-head"><strong>${esc(draft.to || 'No recipient yet')}</strong><time>${timeShort(draft.updatedAt)}</time></span><div class="row-subject">${esc(draft.subject || 'New message')}</div><p class="row-snippet">${esc((draft.text || '').replace(/\s+/g, ' ') || 'Start writing…')}</p><div class="row-foot"><span>${esc(aliasesOf(state, draft.domain).find(alias => alias.id === draft.aliasId)?.address || 'Choose a sender')}</span><span class="tag">Draft</span></div></button>`; }
function mailboxTabsHTML() {
  return `<nav class="mailbox-tabs" role="tablist" aria-label="Email mailboxes">${mailboxesOf(state, state.selectedDomain).map(alias => { const count = state.messages.filter(message => message.domain === state.selectedDomain && mailboxEntries(message)[alias.address]?.folder === 'inbox' && !mailboxEntries(message)[alias.address].read).length; return `<button role="tab" class="mailbox-tab${activeAddress() === alias.address ? ' active' : ''}" data-action="switch-mailbox" data-address="${esc(alias.address)}" aria-label="Open mailbox ${esc(alias.address)}" aria-selected="${activeAddress() === alias.address}" tabindex="${activeAddress() === alias.address ? '0' : '-1'}" title="${esc(alias.address)}${!alias.enabled ? alias.captured ? ' · Captured mail, read only' : ' · Disabled, history only' : ''}"><span>${esc(alias.address.split('@')[0])}</span>${count ? `<b class="count">${count}</b>` : ''}</button>`; }).join('')}</nav>`;
}
function listHTML() {
  const draftView = view.folder === 'drafts' && !view.query;
  const groups = threads(), drafts = mailboxDrafts().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = draftView ? drafts.length : groups.length;
  const title = view.query ? 'Search results' : folderNames[view.folder];
  return `<section class="message-list" aria-label="${esc(title)} message list">${mailboxTabsHTML()}<div class="list-heading"><div><h1>${title}</h1><p>${view.query ? `“${esc(view.query)}” · ` : ''}${count} ${draftView ? count === 1 ? 'draft' : 'drafts' : count === 1 ? 'conversation' : 'conversations'}${!draftView && view.folder === 'inbox' && !view.query ? ' · this address only' : ''}</p></div>${buttons('refresh', liveMail ? 'Check for new mail' : 'Refresh local preview', 'refresh')}</div>${draftView ? '' : filterHTML()}<div class="thread-list">${draftView ? drafts.map(draftRowHTML).join('') : groups.map(rowHTML).join('')}${!count ? `<div class="empty-list">${icon(view.query ? 'search' : folderIcons[view.folder])}<strong>${view.query ? 'No matching conversations' : draftView ? 'A little room for your next thought' : `Nothing in ${folderNames[view.folder]}`}</strong><p>${view.query ? 'Try another word or clear your filters.' : draftView ? 'Your unfinished messages will be kept here.' : view.folder === 'trash' ? 'Mail stays here until you delete it permanently.' : 'You’re all caught up here.'}</p>${view.query || view.alias || view.source || view.environment || view.unread ? '<button class="text-button" data-action="reset-view">Clear search & filters</button>' : ''}</div>` : ''}</div><div class="list-footer"><span>${liveMail ? 'Live mail' : draftView ? 'Drafts stay in this browser' : 'Sample mail · no live connection'}</span><span>${esc(activeAddress())}</span></div></section>`;
}
function mailCardHTML(message, collapsed) {
  const sender = `<span class="sender-avatar">${esc(initials(message.fromName))}</span>`;
  const markup = `<div class="sender-line">${sender}<div class="sender-details"><strong>${esc(message.fromName)}<span class="email-address">&lt;${esc(message.from)}&gt;</span></strong><p>to ${esc(message.to.join(', '))}${message.cc?.length ? ` · cc ${esc(message.cc.join(', '))}` : ''}${message.bcc?.length ? ` · bcc ${esc(message.bcc.join(', '))}` : ''}</p>${message.source === 'automated' ? `<p>${esc(message.producer || 'Project mail')} · ${message.environment === 'staging' ? 'Staging' : 'Production'}</p>` : ''}${message.delivery ? `<p>${DELIVERY[message.delivery.state] || esc(message.delivery.state)}${message.delivery.detail ? ` · ${esc(message.delivery.detail)}` : ''}</p>` : ''}${message.quarantined ? '<p>This message failed a virus check. Its attachments are withheld.</p>' : ''}</div><time datetime="${message.date}">${timeFull(message.date)}</time></div>
    ${message.html ? `${/src\s*=\s*["']https?:/i.test(message.html) && !remoteLoaded.has(message.id) && !state.preferences.externalImages ? `<div class="remote-notice">Remote images are hidden.<button data-action="load-images" data-id="${esc(message.id)}">Load images</button></div>` : ''}<iframe class="message-frame" title="Email from ${esc(message.fromName)}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" data-message-frame="${esc(message.id)}"></iframe>` : `<div class="body-text">${esc(message.text)}</div>`}
    ${message.attachments?.length ? `<div class="attachment-list">${message.attachments.filter(file => !file.inline).map(file => `<button class="attachment" data-action="download" data-message="${esc(message.id)}" data-id="${esc(file.id)}">${icon('drafts')}<span><strong>${esc(file.name)}</strong><small>${prettySize(file.size)} · Download</small></span><span class="download-icon">${icon('download')}</span></button>`).join('')}</div>` : ''}`;
  return `<article class="message-card" aria-label="Message from ${esc(message.fromName)}">${collapsed ? `<details><summary><span class="collapsed-message">${sender}<strong>${esc(message.fromName)}</strong><span class="preview">${esc(message.text.slice(0, 90))}</span>${icon('chevron')}</span></summary>${markup}</details>` : markup}</article>`;
}
function readerHTML() {
  const group = selectedGroup();
  if (!group) return `<section class="reader" aria-label="Reading pane"><div class="reader-toolbar"><span class="toolbar-note">${icon('mail')}A calmer place for your project mail</span></div><div class="reader-empty"><div class="empty-icon">${icon('mail')}</div><h2>One address at a time.</h2><p>Choose a conversation, or start a new one from ${esc(activeAddress())}.</p><button class="secondary-button" data-action="compose" ${canCompose() ? '' : 'disabled'}>${icon('plus')}Write a message</button><span class="keyboard-note"><kbd>C</kbd> to compose <span>·</span> <kbd>/</kbd> to search</span></div></section>`;
  const messages = currentConversation(), message = messages.at(-1), position = threads().findIndex(item => item.id === group.id), matches = group.matching;
  const trash = matches.every(item => item.folder === 'trash');
  return `<section class="reader" aria-label="Reading pane"><div class="reader-toolbar">${buttons('left', 'Back to message list', 'back', 'data-back="true"').replace('class="icon-button"', 'class="icon-button back-button"')}${buttons('archive', 'Archive conversation', 'archive')}${buttons('trash', trash ? 'Delete permanently' : 'Move conversation to Trash', trash ? 'delete-permanently' : 'trash')}${buttons('mail', 'Mark conversation unread', 'mark-unread')}<span class="toolbar-separator"></span>${buttons('more', 'More message actions', 'toggle-more')}
    <div class="right-actions"><span class="message-position">${position + 1} of ${threads().length}</span>${buttons('left', 'Previous conversation', 'previous', position === 0 ? 'disabled' : '')}${buttons('right', 'Next conversation', 'next', position === threads().length - 1 ? 'disabled' : '')}</div></div>
    ${view.more ? `<div class="popover-menu">${matches.some(item => ['trash', 'spam', 'archive'].includes(item.folder)) ? `<button data-action="restore">${icon('inbox')}Move to Inbox</button>` : ''}<button data-action="spam">${icon('spam')}Move to Spam</button><button data-action="reply-all">${icon('reply')}Reply all</button>${liveMail ? '' : `<button data-action="download-original">${icon('download')}Download sample .eml</button>`}</div>` : ''}
    <div class="reader-scroll"><div class="subject-line"><h2>${esc(group.latest.subject)}</h2></div><div class="reader-labels"><span class="recipient-badge">${esc(activeAddress())}</span>${tags(group.latest)}${group.latest.status === 'sample' && group.latest.folder === 'sent' ? '<span class="tag">Sample message</span>' : ''}</div>
    ${trash ? '<div class="retention-note">This conversation is in Trash. It will stay here until you explicitly delete it permanently. <button class="text-button" data-action="restore">Move to Inbox</button></div>' : ''}
    ${messages.map((item, i) => mailCardHTML(item, i < messages.length - 1)).join('')}
    <div class="reply-actions"><button class="secondary-button" data-action="reply" ${canCompose() ? '' : 'disabled'}>${icon('reply')}Reply</button><button class="secondary-button" data-action="forward" ${canCompose() ? '' : 'disabled'}>${icon('forward')}Forward</button></div></div></section>`;
}
function mountFrames() {
  root.querySelectorAll('[data-message-frame]').forEach(frame => {
    const message = state.messages.find(item => item.id === frame.dataset.messageFrame && item.domain === state.selectedDomain);
    if (message) { frame.srcdoc = messageDocument(message.html, remoteLoaded.has(message.id) || state.preferences.externalImages); frame.style.height = `${Math.max(250, Math.min(750, 140 + (message.text || htmlText(message.html)).split('\n').length * 22))}px`; }
  });
}
function render() {
  const domain = domainOf(state, state.selectedDomain); if (!domain) return;
  state.selectedMailboxes ||= {}; state.selectedMailboxes[domain.id] = activeAddress();
  if (view.selected && !selectedGroup()) view.selected = null;
  document.documentElement.style.setProperty('--accent', domain.id === 'example.org' ? '#365f8c' : '#426859');
  root.innerHTML = `<div class="app-shell${view.selected ? ' has-selection' : ''}${view.mobileSidebar ? ' sidebar-open' : ''}"><button class="mobile-backdrop" data-action="close-sidebar" aria-label="Close navigation"></button>${sidebarHTML()}<main class="workspace">${topbarHTML()}<div class="mail-layout">${listHTML()}${readerHTML()}</div><button class="mobile-compose" data-action="compose" aria-label="Compose" ${canCompose() ? '' : 'disabled'}>${icon('plus')}Compose</button></main></div>`;
  mountFrames(); document.title = `${view.query ? 'Search' : folderNames[view.folder]} · ${activeAddress()}`;
}

function setFolder(folder) { searchCache.clear(); view = { ...view, folder, selected: null, query: '', alias: '', source: '', environment: '', unread: false, mobileSidebar: false, filters: false, more: false }; render(); }
async function openThread(thread) {
  view.selected = thread; view.more = false;
  for (const message of state.messages.filter(message => message.domain === state.selectedDomain && message.thread === thread && inMailbox(message, activeAddress()))) setMailboxState(message, activeAddress(), { read: true });
  // Keep an unread-filtered conversation visible while it is being read.
  if (view.unread) view.unread = false;
  render();
  if (liveMail && currentConversation().some(message => !message.loaded)) {
    try { await loadConversation(state, state.selectedDomain, thread, activeAddress()); } catch (error) { toast(error.message, { error: true }); }
    if (view.selected === thread) render();
  }
  await commit();
}
async function moveCurrent(folder) {
  const group = selectedGroup(); if (!group) return;
  const ids = group.matching.map(message => message.id), before = group.matching.map(message => ({ id: message.id, folder: message.folder, previousFolder: message.previousFolder }));
  const domain = state.selectedDomain, address = activeAddress();
  moveMessages(state, domain, ids, folder, address); view.selected = null; view.more = false; render(); await commit();
  toast(`Moved to ${folderNames[folder]}.`, { undo: async () => { for (const item of before) { const message = state.messages.find(message => message.id === item.id && message.domain === domain); if (message && !state.deleted.some(deleted => deleted.id === item.id && deleted.domain === domain && (!deleted.mailbox || deleted.mailbox === address))) setMailboxState(message, address, { folder: item.folder, previousFolder: item.previousFolder }); } render(); await commit(); } });
}
function confirmAction(title, copy, label, callback) {
  confirmCallback = callback;
  confirmDialog.innerHTML = `<div class="dialog-header"><h2 id="confirm-title">${esc(title)}</h2>${buttons('close', 'Cancel', 'cancel-confirm')}</div><div class="dialog-body"><p class="confirm-copy">${esc(copy)}</p></div><div class="dialog-actions"><button class="secondary-button" data-action="cancel-confirm">Cancel</button><button class="primary-button danger-button" data-action="confirm">${esc(label)}</button></div>`;
  confirmDialog.showModal();
}

function senderOptions(draft) {
  const alias = aliasesOf(state, draft.domain).find(alias => alias.id === draft.aliasId);
  return `<option value="${esc(alias?.id || '')}">${esc(alias?.name || '')} &lt;${esc(alias?.address || draft.mailbox)}&gt;${!alias?.enabled ? ' · disabled' : ''}</option>`;
}
function openComposer({ draftId, mode = 'new' } = {}) {
  if (composer) return;
  if (!canCompose()) { toast('This mailbox is read only. Select an enabled address to compose.', { error: true }); return; }
  const existing = state.drafts.find(draft => draft.id === draftId && draft.domain === state.selectedDomain && draft.aliasId === selectedMailbox(state)?.id);
  const message = currentConversation().at(-1), ownAddresses = aliasesOf(state, state.selectedDomain).map(alias => alias.address);
  const domain = existing?.domain || state.selectedDomain;
  const alias = selectedMailbox(state);
  let body = '', to = '', cc = '', subject = '', thread, replyToId;
  if (mode !== 'new' && message) {
    const ownMessage = ownAddresses.includes(message.from);
    to = mode === 'forward' ? '' : ownMessage ? message.to.filter(address => !ownAddresses.includes(address)).join(', ') : message.replyTo || message.from;
    if (mode === 'reply-all') cc = [...new Set([...message.to, ...(message.cc || [])].filter(address => !ownAddresses.includes(address) && address !== to))].join(', ');
    subject = mode === 'forward' ? `Fwd: ${message.subject.replace(/^\s*fwd:\s*/i, '')}` : `Re: ${message.subject.replace(/^\s*re:\s*/i, '')}`;
    body = `<p><br></p><p><br></p><blockquote><p>On ${esc(timeFull(message.date))}, ${esc(message.fromName)} wrote:</p>${message.html ? sanitizeHTML(message.html) : `<p>${esc(message.text).replace(/\n/g, '<br>')}</p>`}</blockquote>`;
    if (mode !== 'forward') { thread = message.thread; replyToId = message.id; }
  }
  composer = existing ? { ...structuredClone(existing), mailbox: alias.address, dirty: false, rev: 0 } : { id: uid(), domain, mailbox: alias.address, aliasId: alias?.id || '', to, cc, bcc: '', subject, text: htmlText(body), html: body, thread, replyToId, attachments: mode === 'forward' && message ? structuredClone(message.attachments || []) : [], dirty: Boolean(mode !== 'new'), rev: 0 };
  const invalidSender = !aliasesOf(state, domain).some(item => item.id === composer.aliasId && item.enabled);
  composeDialog.innerHTML = `<div class="compose-content"><div class="dialog-header"><div><h2 id="compose-title">${existing ? 'Draft' : mode === 'forward' ? 'Forward message' : mode !== 'new' ? 'Reply' : 'New message'}<span class="tag">${esc(composer.mailbox)}</span></h2><p>Sending from ${esc(composer.mailbox)}${liveMail ? '' : ' · local preview'}</p></div>${buttons('close', 'Save and close draft', 'close-composer')}</div><div class="compose-fields"><div class="compose-field"><label for="compose-from">From</label><select id="compose-from" disabled title="Sender is fixed to this mailbox. Close this draft and switch mailboxes to use another address.">${senderOptions(composer)}</select></div><div class="compose-field"><label for="compose-to">To</label><input id="compose-to" type="text" inputmode="email" placeholder="Email addresses, separated by commas" value="${esc(composer.to)}" autocomplete="off"><button class="cc-toggle" data-action="toggle-cc" type="button">Cc / Bcc</button></div><div id="extra-recipients" ${composer.cc || composer.bcc ? '' : 'hidden'}><div class="compose-field"><label for="compose-cc">Cc</label><input id="compose-cc" type="text" inputmode="email" value="${esc(composer.cc)}" autocomplete="off"></div><div class="compose-field"><label for="compose-bcc">Bcc</label><input id="compose-bcc" type="text" inputmode="email" value="${esc(composer.bcc)}" autocomplete="off"></div></div><div class="compose-field"><label for="compose-subject" class="sr-only">Subject</label><input id="compose-subject" class="compose-subject" placeholder="Subject" spellcheck="true" lang="en" autocorrect="on" value="${esc(composer.subject)}" maxlength="998"></div></div><div class="compose-warning" id="sender-warning" ${invalidSender ? '' : 'hidden'}>This mailbox is disabled or unavailable. Sending is blocked.</div><div class="editor-tools" role="toolbar" aria-label="Message formatting"><button class="format-button" data-format="bold" title="Bold" aria-label="Bold"><b>B</b></button><button class="format-button" data-format="italic" title="Italic" aria-label="Italic"><i>I</i></button><button class="format-button" data-format="underline" title="Underline" aria-label="Underline"><u>U</u></button><span class="toolbar-separator"></span><button class="format-button" data-format="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">${icon('list')}</button><button class="format-button" data-format="formatBlock" title="Heading" aria-label="Heading">H₂</button><button class="format-button" data-action="show-link" title="Insert link" aria-label="Insert link">${icon('link')}</button><button class="format-button" data-action="insert-signature" title="Insert alias signature" aria-label="Insert alias signature">S̲</button></div><div class="link-entry" id="link-entry" hidden><label class="sr-only" for="link-url">Link URL</label><input id="link-url" type="url" placeholder="https://example.net"><button class="text-button" data-action="apply-link">Insert</button><button class="text-button" data-action="hide-link">Cancel</button></div><div id="message-editor" class="editor" contenteditable="true" role="textbox" aria-label="Message body" aria-multiline="true" data-placeholder="Write something thoughtful…" lang="en" spellcheck="true" autocorrect="on" autocapitalize="sentences">${sanitizeHTML(composer.html)}</div><div class="compose-attachments" id="compose-attachments"></div><p class="form-error" id="compose-error" role="alert" style="margin:0 21px" hidden></p><input type="file" id="attachment-input" multiple hidden><input type="file" id="inline-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><div class="compose-footer"><button class="primary-button" data-action="send-local" title="${liveMail ? 'Send this email' : 'Save to the local Sent folder. No email is sent.'}">${icon('send')}${liveMail ? 'Send' : 'Send locally'}</button>${buttons('clip', 'Attach files', 'attach-files')}${buttons('image', 'Insert inline image', 'attach-inline')}<span class="save-status" id="draft-save-status">${liveMail ? existing ? 'Draft saved' : '' : existing ? 'Saved in this browser' : 'Draft stays in this browser'}</span>${buttons('trash', 'Discard draft', 'discard-draft')}</div></div>`;
  refreshComposeAttachments(); composeDialog.showModal();
  setTimeout(() => { if (mode === 'new' && !composer.to) document.querySelector('#compose-to')?.focus(); else { const editor = document.querySelector('#message-editor'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); } }, 0);
  if (composer.dirty) scheduleDraftSave();
}
function captureDraft() {
  if (!composer) return;
  for (const field of ['to', 'cc', 'bcc', 'subject']) composer[field] = document.querySelector(`#compose-${field}`).value;
  composer.aliasId = document.querySelector('#compose-from').value;
  composer.html = sanitizeHTML(document.querySelector('#message-editor').innerHTML);
  composer.text = htmlText(composer.html);
}
function draftRecord() { const { id, domain, mailbox, aliasId, to, cc, bcc, subject, text, html, thread, replyToId, attachments } = composer; return structuredClone({ id, domain, mailbox, aliasId, to, cc, bcc, subject, text, html, thread, replyToId, attachments, updatedAt: new Date().toISOString() }); }
function scheduleDraftSave() {
  if (!composer) return;
  composer.dirty = true; composer.rev++; clearTimeout(draftTimer);
  const label = document.querySelector('#draft-save-status'); if (label) label.textContent = 'Saving…';
  draftTimer = setTimeout(() => void saveDraft(), 400);
}
async function saveDraft() {
  if (!composer || !composer.dirty) return true;
  clearTimeout(draftTimer); captureDraft();
  const version = composer.rev, id = composer.id, record = draftRecord(), position = state.drafts.findIndex(item => item.id === id);
  if (position < 0) state.drafts.push(record); else state.drafts[position] = record;
  const ok = await commit();
  if (composer?.id === id && composer.rev === version) { composer.dirty = !ok; const label = document.querySelector('#draft-save-status'); if (label) { label.textContent = ok ? liveMail ? 'Draft saved' : 'Saved in this browser' : 'Not saved — keep this tab open'; label.classList.toggle('unsaved-warning', !ok); } }
  return ok;
}
async function closeComposer() {
  if (composer?.dirty && !await saveDraft()) return;
  clearTimeout(draftTimer); composer = null; lastRange = null; composeDialog.close(); render();
}
function refreshComposeAttachments() {
  const area = document.querySelector('#compose-attachments'); if (!area || !composer) return;
  area.innerHTML = composer.attachments.map(file => `<span class="file-chip">${icon(file.inline ? 'image' : 'clip')}<span>${esc(file.name)} · ${prettySize(file.size)}${file.inline ? ' · inline' : ''}</span><button data-action="remove-file" data-id="${esc(file.id)}" aria-label="Remove ${esc(file.name)}">${icon('close')}</button></span>`).join('');
}
function rememberSelection() {
  const selection = getSelection(), editor = document.querySelector('#message-editor');
  if (selection?.rangeCount && editor?.contains(selection.anchorNode)) lastRange = selection.getRangeAt(0).cloneRange();
}
function restoreSelection() {
  const editor = document.querySelector('#message-editor'); if (!editor) return;
  editor.focus(); const selection = getSelection(); selection.removeAllRanges();
  if (lastRange && editor.contains(lastRange.commonAncestorContainer)) selection.addRange(lastRange); else { const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.addRange(range); }
}
function insertHTML(html) { restoreSelection(); document.execCommand('insertHTML', false, sanitizeHTML(html)); rememberSelection(); scheduleDraftSave(); }
async function addFiles(files, inline = false) {
  if (!composer || !files.length) return;
  const id = composer.id, total = composer.attachments.reduce((sum, file) => sum + file.size, 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (files.some(file => file.size > MAX_FILE_BYTES) || total > MAX_TOTAL_BYTES || files.length + composer.attachments.length > 10) { toast('Use up to 10 files, 10 MB each and 20 MB combined.', { error: true }); return; }
  if (inline && files.some(file => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) { toast('Use a PNG, JPEG, GIF, or WebP image.', { error: true }); return; }
  for (const file of files) {
    const record = { id: uid(), name: file.name || 'Pasted image.png', type: file.type || 'application/octet-stream', size: file.size, blob: file, inline };
    if (inline) { const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); if (composer?.id !== id) return; composer.attachments.push(record); insertHTML(`<p><img src="${url}" data-file-id="${record.id}" alt="${esc(record.name)}"></p>`); }
    else if (composer?.id === id) composer.attachments.push(record);
  }
  refreshComposeAttachments(); scheduleDraftSave();
}
async function submitLocal() {
  if (!composer) return;
  const errorArea = document.querySelector('#compose-error'); errorArea.hidden = true;
  if (!await saveDraft()) return;
  captureDraft(); const previous = structuredClone(state), domain = composer.domain;
  const button = composeDialog.querySelector('[data-action="send-local"]'); button.disabled = true;
  try {
    if (composer.mailbox !== activeAddress()) throw new Error('Switch back to this draft’s mailbox before sending.');
    if (liveMail) {
      composer.attemptId ||= uid();
      const result = await sendDraft(composer), sentId = composer.id;
      clearTimeout(draftTimer); composer = null; composeDialog.close(); lastRange = null;
      state.drafts = state.drafts.filter(draft => draft.id !== sentId);
      const fresh = await loadState(); fresh.selectedDomain = state.selectedDomain; fresh.selectedMailboxes = state.selectedMailboxes; state = fresh; searchCache.clear(); updateIndex(); render();
      toast(result.state === 'uncertain' ? 'Amazon SES did not confirm this message. Check Sent before sending it again.' : 'Sent.', { error: result.state === 'uncertain' });
      return;
    }
    sendLocally(state, composer); updateIndex();
    if (!await commit()) { state = previous; updateIndex(); button.disabled = false; return; }
    clearTimeout(draftTimer); composer = null; composeDialog.close(); lastRange = null;
    if (state.selectedDomain === domain) { view.query = ''; view.unread = false; view.alias = ''; view.source = ''; view.environment = ''; }
    render(); toast('Saved to local Sent. No email was sent.');
  } catch (error) { errorArea.textContent = error.message; errorArea.hidden = false; button.disabled = false; }
}
function openSettings(tab = 'aliases') { settingsTab = tab; settingsDomain = state.selectedDomain; renderSettings(); settingsDialog.showModal(); }
function renderSettings() {
  const domain = domainOf(state, settingsDomain || state.selectedDomain);
  let content;
  if (settingsTab === 'aliases') content = `<div class="panel-heading"><h3>Addresses & identities</h3><label class="sr-only" for="settings-domain">Alias domain</label><select class="settings-domain-select" id="settings-domain">${state.domains.map(project => `<option value="${esc(project.id)}" ${project.id === domain.id ? 'selected' : ''}>${esc(project.id)}</option>`).join('')}</select></div><p class="panel-description">Each address has its own Inbox, Sent, Drafts, and folders. Compose and reply always use that mailbox’s address.</p>${domain.aliases.map(alias => `<div class="alias-card${alias.enabled ? '' : ' disabled'}"><span class="alias-icon">${icon('mail')}</span><div><strong>${esc(alias.address)}</strong><p>${esc(alias.name)}${alias.default && alias.enabled ? ' <span class="tag">Default sender</span>' : ''}${!alias.enabled ? alias.captured ? ' <span class="tag">Captured mail · read only</span>' : ' <span class="tag">Disabled</span>' : ''}</p></div><button class="text-button" data-action="edit-alias" data-id="${esc(alias.id)}">Edit</button><button class="text-button${alias.enabled ? '' : ' danger'}" data-action="toggle-alias" data-id="${esc(alias.id)}">${alias.enabled ? 'Disable' : 'Enable'}</button></div>`).join('')}<button class="secondary-button" data-action="add-alias">${icon('plus')}Add address</button><div class="info-box"><strong>Your mail keeps its original identity.</strong>Disabling or renaming an address keeps existing messages and drafts. These settings change only this local preview.</div>`;
  if (settingsTab === 'notifications') content = `<div class="panel-heading"><h3>A heads-up, wherever you are.</h3></div><p class="panel-description">Sender and subject on your lock screen. The message itself stays in your inbox.</p><label class="setting-row"><span><strong>New-mail notifications</strong><p>Remember this preference for the hosted app.</p></span><input class="switch" type="checkbox" id="notification-toggle" ${state.preferences.notifications ? 'checked' : ''}></label><div class="notification-preview"><div class="notification-card">${icon('mail')}<div><small>Inbox · ${esc(domain.id)}</small><strong>${domain.id === 'example.com' ? 'Alex Morgan' : 'Morgan Ellis'}</strong><p>${domain.id === 'example.com' ? 'A conversation about the next workshop' : 'A question about inviting our team'}</p></div></div></div><button class="secondary-button" data-action="preview-notification">${icon('bell')}Preview notification</button><div class="info-box">On iPhone, the hosted app will be added to your Home Screen. Background delivery will be connected later; this local preview doesn’t request notification permission.</div>`;
  if (settingsTab === 'storage') {
    const localMessages = state.messages.filter(message => message.status === 'local').length, files = [...state.messages, ...state.drafts].flatMap(item => item.attachments || []), bytes = files.reduce((sum, file) => sum + file.size, 0);
    content = `<div class="panel-heading"><h3>Keep what matters.</h3></div><p class="panel-description">Mail stays in every folder until you decide to delete it permanently. Trash never empties itself.</p><div class="storage-stat">${state.messages.length} <small>local messages · ${localMessages} composed here</small></div><div class="storage-meter"><span></span></div><label class="setting-row"><span><strong>Mail and Trash</strong><p>No automatic expiry</p></span><span class="tag">Keep until deleted</span></label><div class="setting-row"><span><strong>Private recovery window</strong><p>30 days after permanent deletion in the hosted app</p></span></div><div class="setting-row"><span><strong>Attachments in this preview</strong><p>${files.length} files · ${prettySize(bytes)}</p></span></div><div class="info-box">Local data is saved in this browser, not synced between devices. This preview does not create cloud backups or connect to your real inbox.</div>`;
  }
  if (settingsTab === 'preview') content = `<div class="panel-heading"><h3>Your preview workspace.</h3></div><p class="panel-description">Try the full flow with fictional messages. Sending saves a message to local Sent; it doesn’t deliver an email.</p><div class="setting-row"><span><strong>Owner account</strong><p>owner@example.net · Google sign-in will be connected later</p></span></div><div class="setting-row"><span><strong>Sample incoming mail</strong><p>Add a fictional message to ${esc(domain.id === state.selectedDomain ? activeAddress() : defaultAlias(state, domain.id)?.address || domain.id)}.</p></span><button class="secondary-button" data-action="sample-incoming">Add sample</button></div><label class="setting-row"><span><strong>Load external email images</strong><p>Off by default. You can also load them per message.</p></span><input class="switch" type="checkbox" id="external-images-toggle" ${state.preferences.externalImages ? 'checked' : ''}></label><div class="info-box">Keyboard shortcuts: C to compose, / to search, and ⌘/Ctrl + Enter to send locally. Close a message draft to save it for later.</div><button class="text-button danger" style="margin-top:22px" data-action="reset-preview">Reset local sample data</button>`;
  settingsDialog.innerHTML = `<div class="dialog-header"><div><h2 id="settings-title">Aliases & settings</h2><p>Your project mail, your preferences.</p></div>${buttons('close', 'Close settings', 'close-settings')}</div><div class="settings-layout"><nav class="settings-tabs" aria-label="Settings sections">${[['aliases','mail','Addresses'],['notifications','bell','Notifications'],['storage','storage','Storage'],['preview','settings','Local preview']].map(([id, symbol, label]) => `<button class="settings-tab${settingsTab === id ? ' active' : ''}" data-action="settings-tab" data-tab="${id}" ${settingsTab === id ? 'aria-current="page"' : ''}>${icon(symbol)}${label}</button>`).join('')}</nav><section class="settings-panel">${content}</section></div>`;
}
function editAlias(id) {
  const alias = aliasesOf(state, settingsDomain).find(item => item.id === id);
  aliasDialog.innerHTML = `<form id="alias-form" data-old-address="${esc(alias?.address || '')}"><input type="hidden" name="id" value="${esc(alias?.id || '')}"><div class="dialog-header"><h2 id="alias-title">${alias ? 'Edit address' : 'Add an address'}</h2>${buttons('close', 'Cancel address edit', 'cancel-alias')}</div><div class="dialog-body"><label class="form-field">Email address<input name="address" type="email" required placeholder="name@${esc(settingsDomain)}" value="${esc(alias?.address || '')}"></label><label class="form-field">Sender display name<input name="name" required maxlength="120" value="${esc(alias?.name || domainOf(state, settingsDomain).name)}"></label><label class="form-field">Signature <span style="font-size:9px">Insert this from the compose toolbar when you need it.</span><textarea name="signature">${esc(alias?.signature || '')}</textarea></label><label class="checkbox-row"><input type="checkbox" name="enabled" ${!alias || alias.enabled ? 'checked' : ''}>Enable sending and receiving</label><label class="checkbox-row"><input type="checkbox" name="makeDefault" ${alias?.default ? 'checked' : ''}>Use as the default sender for this domain</label><div id="rename-options" hidden><div class="info-box">Changing the email address creates a new alias. Existing mail keeps its original address.</div><label class="checkbox-row"><input type="checkbox" name="disableOld">Disable the old address after creating the new one</label></div><p class="form-error" id="alias-error" role="alert" hidden></p></div><div class="dialog-actions"><button type="button" class="secondary-button" data-action="cancel-alias">Cancel</button><button class="primary-button" type="submit">Save address</button></div></form>`;
  aliasDialog.showModal(); aliasDialog.querySelector('[name="address"]').focus();
}
function previewNotification(message) {
  const domain = settingsDialog.open ? settingsDomain : state.selectedDomain;
  message ||= state.messages.find(item => item.domain === domain && (domain !== state.selectedDomain || inMailbox(item, activeAddress())) && mailboxEntries(item)[domain === state.selectedDomain ? activeAddress() : defaultAlias(state, domain)?.address]?.folder === 'inbox');
  const element = document.createElement('div'); element.className = 'toast notification-toast';
  element.innerHTML = `${icon('mail')}<div><strong>${esc(message?.fromName || 'Project mail')}</strong><p>${esc(message?.subject || 'A new conversation is waiting')}</p><p>${esc(message?.domain || domain)} · notification preview</p></div>`;
  document.querySelector('#toasts').append(element); setTimeout(() => element.remove(), 6500);
}
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name.replace(/[\/\\\x00-\x1f]/g, '_'); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }

document.addEventListener('click', async event => {
  const element = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!element || element.disabled) return;
  const { action, id, domain, folder, thread, tab } = element.dataset;
  try {
    switch (action) {
      case 'toggle-domain': view.domainMenu = !view.domainMenu; render(); break;
      case 'switch-domain': state.selectedDomain = domain; view.domainMenu = false; setFolder('inbox'); await commit(); break;
      case 'switch-mailbox': state.selectedMailboxes ||= {}; state.selectedMailboxes[state.selectedDomain] = element.dataset.address; setFolder(selectedMailbox(state)?.captured ? 'sent' : 'inbox'); await commit(); break;
      case 'toggle-sidebar': view.mobileSidebar = !view.mobileSidebar; render(); break;
      case 'close-sidebar': view.mobileSidebar = false; render(); break;
      case 'folder': setFolder(folder); break;
      case 'compose': openComposer(); break;
      case 'resume-draft': openComposer({ draftId: id }); break;
      case 'open-thread': await openThread(thread); break;
      case 'back': view.selected = null; render(); break;
      case 'show-all': view.unread = false; render(); break;
      case 'show-unread': view.unread = true; view.selected = null; render(); break;
      case 'toggle-filters': view.filters = !view.filters; render(); break;
      case 'clear-filters': view.alias = ''; view.source = ''; view.environment = ''; view.unread = false; view.filters = false; view.selected = null; render(); break;
      case 'clear-search': view.query = ''; view.selected = null; render(); document.querySelector('#mail-search').focus(); break;
      case 'reset-view': view.query = ''; view.alias = ''; view.source = ''; view.environment = ''; view.unread = false; view.selected = null; render(); break;
      case 'refresh': {
        if (sharedStorage && composer) { toast('Save and close your draft before refreshing.'); break; }
        refreshing = true; root.inert = true;
        try { await saveQueue.catch(() => {}); const saved = await loadState(); if (saved) { state = saved; searchCache.clear(); updateIndex(); render(); } toast(liveMail ? 'Mail is up to date.' : sharedStorage ? 'Shared sample mailbox is up to date.' : 'Local sample mailbox is up to date.'); }
        finally { refreshing = false; root.inert = false; }
        break;
      }
      case 'archive': await moveCurrent('archive'); break;
      case 'trash': await moveCurrent('trash'); break;
      case 'spam': await moveCurrent('spam'); break;
      case 'restore': await moveCurrent('inbox'); break;
      case 'mark-unread': { for (const item of currentConversation()) { const original = state.messages.find(message => message.id === item.id && message.domain === item.domain); setMailboxState(original, activeAddress(), { read: false }); } view.selected = null; render(); await commit(); toast('Marked as unread.'); break; }
      case 'toggle-more': view.more = !view.more; render(); break;
      case 'previous': case 'next': { const list = threads(), position = list.findIndex(item => item.id === view.selected), next = list[position + (action === 'next' ? 1 : -1)]; if (next) await openThread(next.id); break; }
      case 'reply': case 'reply-all': case 'forward': openComposer({ mode: action }); break;
      case 'load-images': remoteLoaded.add(id); render(); break;
      case 'delete-permanently': { const group = selectedGroup(); if (!group) break; const ids = group.matching.map(item => item.id), activeDomain = state.selectedDomain, address = activeAddress(); confirmAction('Delete this conversation permanently?', 'It will be removed from this mailbox. Copies delivered to another address stay there. The hosted app will retain private recovery copies for up to 30 days, while keeping deleted mail out of your inbox.', 'Delete permanently', async () => { permanentlyDelete(state, activeDomain, ids, new Date().toISOString(), address); view.selected = null; render(); await commit({ reindex: true }); toast(liveMail ? 'Permanently deleted.' : 'Permanently removed from this local preview.'); }); break; }
      case 'download': { const message = state.messages.find(item => item.id === element.dataset.message && item.domain === state.selectedDomain), file = message?.attachments.find(item => item.id === id); if (file && liveMail && !file.blob) { const link = document.createElement('a'); link.href = await attachmentUrl(file); link.rel = 'noopener'; link.click(); } else if (file) downloadBlob(file.blob || new Blob([file.content || ''], { type: file.type }), file.name); break; }
      case 'download-original': { const message = currentConversation().at(-1); if (message) downloadBlob(new Blob([`From: ${message.from}\r\nTo: ${message.to.join(', ')}\r\nSubject: ${message.subject.replace(/[\r\n]/g, ' ')}\r\nDate: ${new Date(message.date).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nX-Local-Prototype: true\r\n\r\n${message.text.replace(/\r?\n/g, '\r\n')}`], { type: 'message/rfc822' }), 'sample-message.eml'); view.more = false; render(); break; }
      case 'close-composer': await closeComposer(); break;
      case 'toggle-cc': document.querySelector('#extra-recipients').hidden = !document.querySelector('#extra-recipients').hidden; break;
      case 'attach-files': rememberSelection(); document.querySelector('#attachment-input').click(); break;
      case 'attach-inline': rememberSelection(); document.querySelector('#inline-input').click(); break;
      case 'remove-file': if (composer) { composer.attachments = composer.attachments.filter(file => file.id !== id); document.querySelectorAll('#message-editor img[data-file-id]').forEach(image => { if (image.dataset.fileId === id) image.remove(); }); refreshComposeAttachments(); scheduleDraftSave(); } break;
      case 'show-link': rememberSelection(); document.querySelector('#link-entry').hidden = false; document.querySelector('#link-url').focus(); break;
      case 'hide-link': document.querySelector('#link-entry').hidden = true; restoreSelection(); break;
      case 'apply-link': { const url = safeLink(document.querySelector('#link-url').value); if (!url) { toast('Use a complete https://, http://, or mailto: link.', { error: true }); break; } restoreSelection(); const selection = getSelection(); if (selection.toString()) document.execCommand('createLink', false, url); else insertHTML(`<a href="${esc(url)}">${esc(url)}</a>`); document.querySelector('#link-entry').hidden = true; scheduleDraftSave(); break; }
      case 'insert-signature': { const alias = aliasesOf(state, composer.domain).find(item => item.id === document.querySelector('#compose-from').value); if (alias?.signature) insertHTML(`<p>${esc(alias.signature).replace(/\n/g, '<br>')}</p>`); else toast('Add a signature in this address’s settings first.'); break; }
      case 'send-local': await submitLocal(); break;
      case 'discard-draft': confirmAction('Discard this draft?', 'The draft and its local attachments will be removed from this browser.', 'Discard draft', async () => { clearTimeout(draftTimer); const draftId = composer.id; composer = null; composeDialog.close(); state.drafts = state.drafts.filter(draft => draft.id !== draftId); await commit(); render(); toast('Draft discarded.'); }); break;
      case 'settings': openSettings(); break;
      case 'close-settings': settingsDialog.close(); render(); break;
      case 'settings-tab': settingsTab = tab; renderSettings(); break;
      case 'add-alias': case 'edit-alias': case 'toggle-alias': case 'sample-incoming': case 'reset-preview': if (liveMail) { toast(action.endsWith('alias') ? 'Addresses are managed in the mail setup for now.' : 'Sample tools are not available with live mail.'); break; }
        if (action === 'add-alias') { editAlias(); break; }
        if (action === 'edit-alias') { editAlias(id); break; }
        if (action === 'toggle-alias') { const alias = aliasesOf(state, settingsDomain).find(item => item.id === id); saveAlias(state, settingsDomain, { ...alias, enabled: !alias.enabled, makeDefault: false }); await commit(); renderSettings(); render(); toast(`${alias.address} ${alias.enabled ? 'enabled' : 'disabled'} locally.`); break; }
        if (action === 'sample-incoming') { const activeDomain = settingsDomain, alias = activeDomain === state.selectedDomain ? selectedMailbox(state) : defaultAlias(state, activeDomain); if (!alias?.enabled) { toast('Select an enabled receiving address first.', { error: true }); break; } const message = { id: uid(), thread: uid(), domain: activeDomain, fromName: 'Avery Quinn', from: 'avery@example.net', to: [alias.address], cc: [], subject: 'A new idea to explore', text: 'Hello,\n\nI have an idea for a project and would love to hear your thoughts. Would you be available for a quick conversation next week?\n\nBest,\nAvery\n\nThis is a fictional message added to the local preview.', html: '', folder: 'inbox', read: false, source: 'manual', environment: 'production', date: new Date().toISOString(), attachments: [] }; state.messages.push(message); await commit({ reindex: true }); render(); if (state.preferences.notifications) previewNotification(message); else toast(`Sample message added to ${activeDomain}.`); break; }
        confirmAction('Reset this local preview?', 'This removes messages you composed here, drafts, attachment files, alias edits, and local preferences. Fictional sample mail will be restored. Your real mail is not connected.', 'Reset preview', async () => { state = seedState(); if (sharedStorage) { const threads = new Map(); for (const message of state.messages) { if (!threads.has(message.thread)) threads.set(message.thread, uid()); message.id = uid(); message.thread = threads.get(message.thread); } } view = { folder: 'inbox', selected: null, query: '', alias: '', source: '', environment: '', unread: false }; settingsDomain = state.selectedDomain; await commit({ reindex: true }); settingsDialog.close(); render(); toast('Local sample workspace restored.'); }); break;
      case 'cancel-alias': aliasDialog.close(); break;
      case 'preview-notification': previewNotification(); break;
      case 'cancel-confirm': confirmCallback = null; confirmDialog.close(); break;
      case 'confirm': { const callback = confirmCallback; confirmCallback = null; element.disabled = true; if (callback) await callback(); confirmDialog.close(); break; }
    }
  } catch (error) { toast(error.message || 'That change could not be completed.', { error: true }); }
});

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'mail-search') { const position = target.selectionStart; view.query = target.value; view.selected = null; view.filters = false; scheduleSearch(); render(); const input = document.querySelector('#mail-search'); input.focus(); input.setSelectionRange(position, position); }
  if (composeDialog.contains(target) && !['link-url', 'attachment-input', 'inline-input'].includes(target.id)) scheduleDraftSave();
  if (target.closest('#alias-form') && target.name === 'address') { const old = document.querySelector('#alias-form').dataset.oldAddress; document.querySelector('#rename-options').hidden = !old || target.value.trim().toLowerCase() === old; }
});
document.addEventListener('change', async event => {
  const target = event.target;
  try {

    if (target.id === 'filter-source') { view.source = target.value; view.selected = null; render(); }
    if (target.id === 'filter-environment') { view.environment = target.value; view.selected = null; render(); }
    if (target.id === 'settings-domain') { settingsDomain = target.value; renderSettings(); }
    if (target.id === 'notification-toggle') { state.preferences.notifications = target.checked; await commit(); }
    if (target.id === 'external-images-toggle') { state.preferences.externalImages = target.checked; await commit(); render(); }
    if (target.id === 'compose-from') { composer.aliasId = target.value; document.querySelector('#sender-warning').hidden = aliasesOf(state, composer.domain).some(alias => alias.id === target.value && alias.enabled); scheduleDraftSave(); }
    if (target.id === 'attachment-input' || target.id === 'inline-input') { await addFiles([...target.files], target.id === 'inline-input'); target.value = ''; }
  } catch (error) { toast(error.message || 'Files could not be added.', { error: true }); }
});
document.addEventListener('submit', async event => {
  if (!event.target.matches('form#alias-form')) return;
  event.preventDefault(); const form = new FormData(event.target), errorArea = document.querySelector('#alias-error');
  if (liveMail) { errorArea.textContent = 'Addresses are managed in the mail setup for now.'; errorArea.hidden = false; return; }
  try { const record = saveAlias(state, settingsDomain, { id: form.get('id'), address: form.get('address'), name: form.get('name'), signature: form.get('signature'), enabled: form.has('enabled'), makeDefault: form.has('makeDefault'), disableOld: form.has('disableOld') }); if (!await commit()) return; aliasDialog.close(); renderSettings(); render(); toast(`${record.address} saved locally.`); }
  catch (error) { errorArea.textContent = error.message; errorArea.hidden = false; }
});
document.addEventListener('mousedown', event => {
  const button = event.target instanceof Element ? event.target.closest('[data-format], [data-action="show-link"], [data-action="insert-signature"]') : null;
  if (!button || !composer) return;
  rememberSelection(); if (button.dataset.format) { event.preventDefault(); document.querySelector('#message-editor').focus(); document.execCommand(button.dataset.format, false, button.dataset.format === 'formatBlock' ? 'h2' : undefined); rememberSelection(); scheduleDraftSave(); }
});
// Keyboard activation of formatting buttons follows the same path as pointer activation.
document.addEventListener('keydown', event => {
  if (!state || refreshing) return;
  if (event.target.matches?.('.mailbox-tab') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.mailbox-tab')], position = tabs.indexOf(event.target);
    const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(position + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    const address = target.dataset.address; target.click();
    [...document.querySelectorAll('.mailbox-tab')].find(tab => tab.dataset.address === address)?.focus();
    return;
  }
  const formatting = event.target instanceof Element ? event.target.closest('[data-format]') : null;
  if (formatting && ['Enter', ' '].includes(event.key)) { event.preventDefault(); restoreSelection(); document.execCommand(formatting.dataset.format, false, formatting.dataset.format === 'formatBlock' ? 'h2' : undefined); scheduleDraftSave(); return; }
  if (composer && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submitLocal(); return; }
  const editing = event.target instanceof Element && (event.target.matches('input,textarea,select') || event.target.isContentEditable);
  if (editing || composeDialog.open || aliasDialog.open || confirmDialog.open || settingsDialog.open || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 'c') { event.preventDefault(); openComposer(); }
  if (event.key === '/') { event.preventDefault(); document.querySelector('#mail-search').focus(); }
  if (event.key === 'Escape') { view.domainMenu = false; view.filters = false; view.more = false; view.mobileSidebar = false; view.selected = null; render(); }
});
composeDialog.addEventListener('cancel', event => { event.preventDefault(); void closeComposer(); });
composeDialog.addEventListener('paste', event => {
  if (!event.target.closest('#message-editor')) return;
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); rememberSelection(); void addFiles(files, files.every(file => file.type.startsWith('image/'))); return; }
  const html = event.clipboardData?.getData('text/html'); if (html) { event.preventDefault(); rememberSelection(); insertHTML(html); }
});
composeDialog.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
composeDialog.addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); rememberSelection(); void addFiles([...event.dataTransfer.files]); } });
document.addEventListener('selectionchange', () => { if (composer) rememberSelection(); });
window.addEventListener('beforeunload', event => { if (composer?.dirty || hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (composer?.dirty) { captureDraft(); const record = draftRecord(), position = state.drafts.findIndex(item => item.id === record.id); if (position < 0) state.drafts.push(record); else state.drafts[position] = record; void commit(); } });

window.addEventListener('inbox:storage-error', event => showStorageError(event.detail));
window.addEventListener('inbox:discard-unsaved', () => { if (composer) composer.dirty = false; });
async function start() {
  try { state = await loadState(); if (!state || state.schema !== 1) { state = seedState(); await persistState(state); } }
  catch (error) {
    if (sharedStorage) { showStorageError(error); root.innerHTML = '<main style="padding:40px"><h1>Shared mail could not be loaded</h1><p>Your saved workspace has not been replaced.</p><button id="retry-start">Try again</button></main>'; document.querySelector('#retry-start').onclick = () => location.reload(); return; }
    state = seedState(); showStorageError(new Error(`${error.message} This preview is running without saved changes.`));
  }
  updateIndex(); settingsDomain = state.selectedDomain; render();
}
await start();

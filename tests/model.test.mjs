import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../web/fixtures.mjs';
import { createSearchIndex, searchIds, visibleThreads, conversation, replyAlias, saveAlias, defaultAlias, moveMessages, permanentlyDelete, sendLocally, validateDraft } from '../web/model.mjs';

test('search includes message text across folders and stays within a domain', () => {
  const state = seedState(), index = createSearchIndex(state.messages);
  assert.deepEqual([...searchIds(index, 'example.com', 'practical audience')], ['d1']);
  assert.equal(searchIds(index, 'example.org', 'practical audience').size, 0);
  assert.ok(searchIds(index, 'example.com', 'final schedule').has('d6'));
  assert.equal(visibleThreads(state, { domain: 'example.com', query: 'final schedule' }, index)[0].latest.folder, 'archive');
});
test('quoted phrases match word boundaries and accent normalization', () => {
  const state = seedState(); state.messages[0].text = 'Café conversations. Teams learn through small experiments.';
  const index = createSearchIndex(state.messages);
  assert.ok(searchIds(index, 'example.com', 'cafe "small experiments"').has('d1'));
  assert.equal(searchIds(index, 'example.com', '"small experiment"').size, 0);
  assert.equal(searchIds(index, 'example.com', '"learn small"').size, 0);
});
test('source, environment and alias filters work together', () => {
  const state = seedState();
  const result = visibleThreads(state, { domain: 'example.org', folder: 'sent', source: 'automated', environment: 'staging' });
  assert.deepEqual(result.map(group => group.latest.id), ['t5']);
  assert.ok(visibleThreads(state, { domain: 'example.org', folder: 'inbox', alias: 'support@example.org' }).every(group => group.matching.every(message => message.to.includes('support@example.org'))));
});
test('thread IDs never combine conversations across domains', () => {
  const state = seedState(); state.messages.find(message => message.id === 't1').thread = 'd-workshop';
  assert.deepEqual(conversation(state, 'example.com', 'd-workshop').map(message => message.id), ['d0', 'd1']);
  moveMessages(state, 'example.com', ['d1', 't1'], 'archive');
  assert.equal(state.messages.find(message => message.id === 't1').folder, 'inbox');
});
test('reply chooses the receiving alias, falling back when it is disabled', () => {
  const state = seedState(), message = state.messages.find(message => message.id === 'd1');
  assert.equal(replyAlias(state, 'example.com', message).address, 'taylor@example.com');
  state.domains[0].aliases[1].enabled = false;
  assert.equal(replyAlias(state, 'example.com', message).address, 'info@example.com');
});
test('renaming creates a new alias, preserves history, and can disable the old address', () => {
  const state = seedState();
  const record = saveAlias(state, 'example.com', { id: 'd-info', address: 'hello@example.com', name: 'Example', enabled: true, makeDefault: true, disableOld: true });
  assert.notEqual(record.id, 'd-info');
  assert.equal(state.domains[0].aliases.find(alias => alias.id === 'd-info').enabled, false);
  assert.equal(defaultAlias(state, 'example.com').address, 'hello@example.com');
  assert.deepEqual(state.messages.find(message => message.id === 'd2').to, ['info@example.com']);
  assert.throws(() => saveAlias(state, 'example.com', { address: 'hello@example.org', name: 'Wrong domain' }));
  assert.throws(() => saveAlias(state, 'example.com', { address: 'hello@example.com', name: 'Duplicate' }));
});
test('Trash has no age-based expiry; permanent deletion affects only selected Trash mail in its domain', () => {
  const state = seedState(), old = state.messages.find(message => message.id === 'd7'); old.date = '2001-01-01T00:00:00Z';
  assert.equal(visibleThreads(state, { domain: 'example.com', folder: 'trash' }).length, 1);
  assert.equal(permanentlyDelete(state, 'example.com', ['d1', 't1', 'd7']).length, 1);
  assert.ok(state.messages.some(message => message.id === 'd1'));
  assert.ok(state.messages.some(message => message.id === 't1'));
  assert.equal(state.messages.some(message => message.id === 'd7'), false);
  assert.equal(state.deleted[0].id, 'd7');
});
function draft() { return { id: 'local-send', domain: 'example.com', aliasId: 'd-taylor', to: 'person@example.net', cc: '', bcc: '', subject: 'A prototype message', text: 'A useful conversation', html: '<p>A useful conversation</p>', attachments: [] }; }
test('local sending uses the selected alias, consumes its draft, and prevents duplicate sends', () => {
  const state = seedState(), item = draft(); state.drafts.push(item);
  const message = sendLocally(state, item, '2026-10-26T12:00:00Z');
  assert.equal(message.from, 'taylor@example.com'); assert.equal(message.status, 'local'); assert.equal(message.folder, 'sent');
  assert.equal(state.drafts.length, 0); assert.throws(() => sendLocally(state, item), /already/);
  assert.equal(visibleThreads(state, { domain: 'example.org', query: 'prototype message' }).length, 0);
});
test('disabled aliases, invalid recipients and attachment totals block sending', () => {
  const state = seedState(); state.domains[0].aliases[1].enabled = false;
  assert.throws(() => validateDraft(state, draft()), /enabled sender/);
  state.domains[0].aliases[1].enabled = true;
  assert.throws(() => validateDraft(state, { ...draft(), to: 'person@example.net\r\nBcc: another@example.net' }), /valid email/);
  assert.throws(() => validateDraft(state, { ...draft(), attachments: [{ size: 11 * 1024 * 1024 }] }), /10 MB/);
  assert.throws(() => validateDraft(state, { ...draft(), attachments: [{ size: 9 * 1024 * 1024 }, { size: 9 * 1024 * 1024 }, { size: 9 * 1024 * 1024 }] }), /20 MB/);
});

test('search and conversation history stay within an address even with shared thread IDs', () => {
  const state = seedState();
  state.messages.find(message => message.id === 't2').thread = 't-access';
  assert.deepEqual(conversation(state, 'example.org', 't-access', 'support@example.org').map(message => message.id), ['t1']);
  assert.deepEqual(conversation(state, 'example.org', 't-access', 'info@example.org').map(message => message.id), ['t2']);
  assert.equal(visibleThreads(state, { domain: 'example.org', alias: 'info@example.org', query: 'inviting our team' }).length, 0);
  // A sent message belongs to its sender, even when its recipient is another managed alias.
  const item = { ...draft(), mailbox: 'taylor@example.com', to: 'info@example.com' };
  sendLocally(state, item);
  assert.equal(visibleThreads(state, { domain: 'example.com', alias: 'info@example.com', folder: 'sent' }).some(group => group.latest.id === item.id), false);
  assert.equal(visibleThreads(state, { domain: 'example.com', alias: 'taylor@example.com', folder: 'sent' }).some(group => group.latest.id === item.id), true);
});
test('copies delivered to two aliases have independent read, folder, and deletion state', async () => {
  const { setMailboxState, mailboxEntries } = await import('../web/model.mjs');
  const state = seedState(), message = state.messages.find(message => message.id === 't1');
  message.cc = ['info@example.org'];
  setMailboxState(message, 'support@example.org', { read: true });
  assert.equal(mailboxEntries(message)['info@example.org'].read, false);
  moveMessages(state, 'example.org', ['t1'], 'trash', 'support@example.org');
  assert.equal(mailboxEntries(message)['info@example.org'].folder, 'inbox');
  assert.equal(permanentlyDelete(state, 'example.org', ['t1'], '2026-10-26T12:00:00Z', 'support@example.org').length, 1);
  assert.equal(visibleThreads(state, { domain: 'example.org', alias: 'support@example.org', query: 'inviting our team' }).length, 0);
  assert.equal(visibleThreads(state, { domain: 'example.org', alias: 'info@example.org', folder: 'inbox' }).some(group => group.latest.id === 't1'), true);
  assert.equal(state.deleted[0].mailbox, 'support@example.org');
});
test('a draft cannot send using another mailbox identity', () => {
  assert.throws(() => validateDraft(seedState(), { ...draft(), mailbox: 'info@example.com' }), /must match/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailbox } from '../mail/mailbox.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { mailFixture } from './helpers/mail-fixture.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'local PostgreSQL is not installed';
async function setup() { const f = await mailFixture(db); return { ...f, mailbox: createMailbox({ pool: db.pool, objects: f.objects }) }; }

test('conversations page by latest message and never repeat across pages', { skip }, async () => {
  const t = await setup();
  for (let i = 0; i < 5; i++) await t.deliver(['info@example.com'], { subject: `Topic ${i}`, messageId: `<t${i}@example.net>` });
  await t.deliver(['info@example.com'], { subject: 'Re: Topic 0', inReplyTo: '<t0@example.net>' });
  const first = await t.mailbox.listThreads({ mailbox: 'info@example.com', limit: 2 });
  assert.deepEqual(first.threads.map(item => [item.subject, item.count, item.unread]), [['Re: Topic 0', 2, true], ['Topic 4', 1, true]]);
  const second = await t.mailbox.listThreads({ mailbox: 'info@example.com', limit: 2, cursor: first.cursor });
  const third = await t.mailbox.listThreads({ mailbox: 'info@example.com', limit: 2, cursor: second.cursor });
  assert.deepEqual([...second.threads, ...third.threads].map(item => item.subject), ['Topic 3', 'Topic 2', 'Topic 1']);
  assert.equal(third.cursor, null);
  assert.equal((await t.mailbox.listThreads({ mailbox: 'taylor@example.com' })).threads.length, 0);
  await assert.rejects(t.mailbox.listThreads({ mailbox: 'info@example.com', cursor: 'bogus' }), { status: 400 });
  await assert.rejects(t.mailbox.listThreads({ mailbox: 'nobody@example.com' }), { status: 404 });
});
test('search ANDs words, respects fields and phrase order, and stays in the alias', { skip }, async () => {
  const t = await setup();
  await t.deliver(['info@example.com'], { subject: 'Invoice for next week', text: 'Please pay the invoice' });
  await t.deliver(['info@example.com'], { subject: 'Week next', text: 'invoice later' });
  await t.deliver(['taylor@example.com'], { subject: 'Invoice for next week', text: 'other alias' });
  const search = (query, field) => t.mailbox.search({ mailbox: 'info@example.com', query, field }).then(result => result.threads.map(item => item.subject).sort());
  assert.deepEqual(await search('invoice week'), ['Invoice for next week', 'Week next']);
  assert.deepEqual(await search('"next week"'), ['Invoice for next week']);
  assert.deepEqual(await search('"next week"', 'body'), []);
  assert.deepEqual(await search('pay', 'subject'), []);
  assert.deepEqual(await search('avery', 'sender'), ['Invoice for next week', 'Week next']);
  assert.deepEqual(await search('missing'), []);
});
test('reading, moving, read state and filters are per alias', { skip }, async () => {
  const t = await setup();
  const [delivery] = await t.deliver(['info@example.com', 'taylor@example.com'], { html: '<p>Hi <b>there</b></p>', attachments: [{ filename: 'a.txt', content: 'abc' }] });
  const [message] = await t.mailbox.readThread({ mailbox: 'info@example.com', thread: delivery.threadId });
  assert.match(message.html, /<b>there<\/b>/); assert.deepEqual(message.attachments.map(item => [item.name, item.size, item.inline]), [['a.txt', 3, false]]);
  await t.mailbox.setState({ mailbox: 'info@example.com', ids: [message.id], folder: 'archive', read: true });
  assert.equal((await t.mailbox.listThreads({ mailbox: 'info@example.com' })).threads.length, 0);
  assert.equal((await t.mailbox.listThreads({ mailbox: 'info@example.com', folder: 'archive' })).threads[0].read, true);
  assert.equal((await t.mailbox.listThreads({ mailbox: 'taylor@example.com', unread: true })).threads.length, 1);
  assert.equal((await t.mailbox.listThreads({ mailbox: 'taylor@example.com', environment: 'staging' })).threads.length, 0);
  await assert.rejects(t.mailbox.readThread({ mailbox: 'info@example.org', thread: delivery.threadId }), { status: 404 });
  await assert.rejects(t.mailbox.setState({ mailbox: 'info@example.com', ids: [message.id], folder: 'drafts' }), { status: 400 });
});
test('permanent deletion needs Trash, keeps other aliases, and blocks replay', { skip }, async () => {
  const t = await setup();
  const [delivery] = await t.deliver(['info@example.com', 'taylor@example.com'], { attachments: [{ filename: 'a.txt', content: 'abc' }] });
  const id = delivery.messageId;
  assert.deepEqual(await t.mailbox.deleteForever({ mailbox: 'info@example.com', ids: [id] }), { deleted: 0 });
  await t.mailbox.setState({ mailbox: 'info@example.com', ids: [id], folder: 'trash' });
  assert.deepEqual(await t.mailbox.deleteForever({ mailbox: 'info@example.com', ids: [id] }), { deleted: 1 });
  await assert.rejects(t.mailbox.attachment({ mailbox: 'info@example.com', id, part: 0 }), { status: 404 });
  assert.equal((await t.mailbox.attachment({ mailbox: 'taylor@example.com', id, part: 0 })).name, 'a.txt');
  // A redelivered publish of the same message must not resurrect the deleted entry.
  const { rows } = await db.pool.query('SELECT receipt_key FROM mail.ingestion_receipts');
  await db.pool.query("UPDATE mail.ingestion_receipts SET state='processing', lease_token='replay'");
  const [m] = (await db.pool.query('SELECT *, received_at::text AS received FROM mail.messages')).rows;
  const replay = { domainId: m.domain_id, messageId: id, threadId: m.thread_id, receivedAt: m.received, sentAt: null, subject: m.subject, senderName: m.sender_name, senderAddress: m.sender_address,
    recipients: JSON.parse(m.recipients_json), snippet: m.snippet, hasAttachments: m.has_attachments, source: m.source, environment: m.environment, verdicts: JSON.parse(m.verdicts_json),
    quarantined: m.quarantined, manifestKey: m.object_manifest_key, generation: m.search_generation, searchPartial: m.search_partial, tokenizerVersion: m.tokenizer_version };
  const { delivered } = await t.repo.publish({ receipt: { key: rows[0].receipt_key, token: 'replay' }, message: replay, aliasIds: [t.aliases.info, t.aliases.taylor], folder: 'inbox' });
  assert.deepEqual(delivered, [t.aliases.taylor]);
});
test('content is purged when the last alias deletes a message, and only then', { skip }, async () => {
  const t = await setup();
  const [delivery] = await t.deliver(['info@example.com', 'taylor@example.com'], { attachments: [{ filename: 'a.txt', content: 'abc' }] });
  const id = delivery.messageId, prefix = `mail/${t.domains.example}/${id}/`;
  const filed = () => [...t.stored.keys()].filter(key => key.startsWith(prefix)).sort();
  const count = async table => (await db.pool.query(`SELECT count(*)::int AS n FROM mail.${table} WHERE message_id=$1`, [id])).rows[0].n;
  assert.deepEqual(filed().map(key => key.slice(prefix.length)), ['body.json', 'manifest.json', 'parts/0', 'raw.eml']);
  for (const mailbox of ['info@example.com', 'taylor@example.com']) await t.mailbox.setState({ mailbox, ids: [id], folder: 'trash' });
  await t.mailbox.deleteForever({ mailbox: 'info@example.com', ids: [id] });
  assert.equal(filed().length, 4, 'taylor@ still holds the message');
  await t.mailbox.deleteForever({ mailbox: 'taylor@example.com', ids: [id] });
  assert.deepEqual(filed(), []);
  for (const table of ['messages', 'message_ids', 'search_positions']) assert.equal(await count(table), 0, table);
  assert.equal(await count('deletion_tombstones'), 2);
  assert.ok([...t.stored.keys()].some(key => key.startsWith('incoming/')), 'the intake copy is left to lifecycle expiry');
});
test('quarantined attachments are withheld', { skip }, async () => {
  const t = await setup();
  const [delivery] = await t.deliver(['info@example.com'], { attachments: [{ filename: 'x.exe', content: 'MZ' }] }, { virus: 'FAIL' });
  await assert.rejects(t.mailbox.attachment({ mailbox: 'info@example.com', id: delivery.messageId, part: 0 }), { status: 403 });
});

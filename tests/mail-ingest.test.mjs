import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { createRepository } from '../mail/repository.mjs';
import { ingestNotification } from '../mail/ingest.mjs';
import { MAX_RAW_BYTES } from '../mail/parse.mjs';
import { digest } from '../mail/text.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';

const bucket = 'mail-bucket', example = randomUUID(), exampleorg = randomUUID();
const ids = { info: randomUUID(), taylor: randomUUID(), trInfo: randomUUID(), support: randomUUID() };
let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });

async function setup() {
  await db.reset();
  for (const [domainId, name] of [[example, 'example.com'], [exampleorg, 'example.org']]) await db.pool.query('INSERT INTO mail.domains VALUES($1,$2,$3,1)', [domainId, name, name]);
  for (const [domainId, aliasId, address, receive] of [[example, ids.info, 'info@example.com', true], [example, ids.taylor, 'taylor@example.com', true], [exampleorg, ids.trInfo, 'info@example.org', true], [exampleorg, ids.support, 'support@example.org', false]]) {
    await db.pool.query('INSERT INTO mail.aliases VALUES($1,$2,$3,$4,$5,true,false,$6,1)', [domainId, aliasId, address, address, receive, '']);
  }
  const stored = new Map(), raws = new Map();
  const objects = { async getRaw(b, key) { return raws.get(key); }, async put(key, body) { stored.set(key, Buffer.from(body)); } };
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const repo = createRepository(db.pool);
  async function deliver(recipients, options = {}, verdicts = {}) {
    const key = `incoming/${randomUUID()}`;
    raws.set(key, options.raw || await new MailComposer({ from: 'Avery <avery@example.net>', to: recipients, subject: 'Hello project', text: 'A new idea about invoices', ...options }).compile().build());
    return notification(recipients, key, verdicts);
  }
  const notification = (recipients, key, verdicts = {}) => ({ notificationType: 'Received', mail: { messageId: `ses-${key}`, timestamp: new Date(clock).toISOString() },
    receipt: { recipients, action: { type: 'S3', bucketName: bucket, objectKey: key }, spamVerdict: { status: verdicts.spam || 'PASS' }, virusVerdict: { status: verdicts.virus || 'PASS' }, spfVerdict: { status: 'PASS' }, dkimVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'GRAY' } } });
  const ingest = n => ingestNotification({ notification: n, repo, objects, bucket, now: () => clock });
  const rows = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  return { repo, objects, stored, deliver, ingest, rows, tick: ms => { clock += ms; } };
}
const skip = !postgresAvailable && 'local PostgreSQL is not installed';

test('one delivery to two aliases publishes one message with independent entries, once', { skip }, async () => {
  const t = await setup(), n = await t.deliver(['info@example.com', 'Taylor@Example.com']);
  const { results: [result] } = await t.ingest(n);
  assert.equal(result.status, 'published'); assert.deepEqual(result.delivered.sort(), [ids.info, ids.taylor].sort());
  const [message] = await t.rows('SELECT * FROM mail.messages');
  assert.equal(message.subject, 'Hello project'); assert.equal(message.snippet, 'A new idea about invoices'); assert.equal(message.sender_address, 'avery@example.net');
  assert.equal((await t.rows('SELECT * FROM mail.mailbox_entries WHERE folder=$1 AND is_read=false', ['inbox'])).length, 2);
  assert.ok((await t.rows('SELECT 1 FROM mail.search_positions WHERE token=$1 AND generation=1', [digest('invoices')])).length);
  assert.ok(t.stored.has(message.object_manifest_key));
  assert.deepEqual((await t.ingest(n)).results.map(item => item.status), ['duplicate']);
  assert.equal((await t.rows('SELECT * FROM mail.messages')).length, 1);
});
test('replies join the thread; mail to both domains becomes separate domain-owned messages', { skip }, async () => {
  const t = await setup();
  await t.ingest(await t.deliver(['info@example.com'], { messageId: '<root@example.net>' }));
  const reply = await t.ingest(await t.deliver(['info@example.com'], { messageId: '<reply@example.net>', inReplyTo: '<ROOT@example.net>' }));
  const [root] = await t.rows('SELECT thread_id FROM mail.messages WHERE message_id <> $1', [reply.results[0].messageId]);
  assert.equal(reply.results[0].threadId, root.thread_id);
  const both = await t.ingest(await t.deliver(['info@example.com', 'info@example.org']));
  assert.deepEqual(both.results.map(item => item.domainId).sort(), [example, exampleorg].sort());
  assert.notEqual(both.results[0].messageId, both.results[1].messageId);
});
test('unknown or receive-disabled recipients are not routed; visible headers are ignored', { skip }, async () => {
  const t = await setup();
  assert.equal((await t.ingest(await t.deliver(['nobody@example.com', 'support@example.org']))).unrouted, true);
  const n = await t.deliver(['taylor@example.com'], { to: ['info@example.com'] });
  assert.deepEqual((await t.ingest(n)).results[0].delivered, [ids.taylor]);
});
test('spam goes to Spam; viruses are quarantined in Spam', { skip }, async () => {
  const t = await setup();
  assert.equal((await t.ingest(await t.deliver(['info@example.com'], {}, { spam: 'FAIL' }))).results[0].folder, 'spam');
  const virus = (await t.ingest(await t.deliver(['info@example.com'], {}, { virus: 'FAIL' }))).results[0];
  assert.equal(virus.folder, 'spam');
  assert.equal((await t.rows('SELECT quarantined FROM mail.messages WHERE message_id=$1', [virus.messageId]))[0].quarantined, true);
});
test('a crashed attempt is retried under a new generation after its lease expires', { skip }, async () => {
  const t = await setup(), n = await t.deliver(['info@example.com']);
  const crash = { ...t.repo, publish: async () => { throw new Error('Crashed'); } };
  await assert.rejects(ingestNotification({ notification: n, repo: crash, objects: t.objects, bucket, now: () => Date.parse('2026-10-28T12:00:00Z') }), /Crashed/);
  assert.equal((await t.ingest(n)).results[0].status, 'busy');
  t.tick(6 * 60000);
  const { results: [result] } = await t.ingest(n);
  assert.equal(result.status, 'published');
  assert.equal((await t.rows('SELECT search_generation FROM mail.messages'))[0].search_generation, 2);
});
test('tombstoned aliases are not re-delivered; unparseable mail fails permanently', { skip }, async () => {
  const t = await setup(), n = await t.deliver(['info@example.com', 'taylor@example.com']);
  const claim = await t.repo.claimReceipt({ domainId: example, receiptKey: 'probe', now: Date.now() });
  await t.rows('INSERT INTO mail.deletion_tombstones VALUES($1,$2,$3,now())', [example, ids.taylor, claim.messageId]);
  // Same message id is only reused by the same receipt, so tombstone that receipt's id.
  const realKey = (await import('node:crypto')).createHash('sha256').update(`${n.mail.messageId}\n${n.receipt.action.objectKey}\n${example}`).digest('hex');
  const real = await t.repo.claimReceipt({ domainId: example, receiptKey: realKey, now: Date.now() });
  await t.rows('INSERT INTO mail.deletion_tombstones VALUES($1,$2,$3,now())', [example, ids.taylor, real.messageId]);
  t.tick(6 * 60000);
  assert.deepEqual((await t.ingest(n)).results[0].delivered, [ids.info]);
  const huge = await t.deliver(['info@example.com'], { raw: Buffer.alloc(MAX_RAW_BYTES + 1) });
  assert.equal((await t.ingest(huge)).results[0].status, 'failed');
  assert.equal((await t.ingest(huge)).results[0].status, 'failed');
});
test('unexpected notifications and objects are rejected permanently', { skip }, async () => {
  const t = await setup(), n = await t.deliver(['info@example.com']);
  await assert.rejects(t.ingest({ ...n, notificationType: 'Bounce' }), { permanent: true });
  await assert.rejects(t.ingest({ ...n, receipt: { ...n.receipt, action: { ...n.receipt.action, bucketName: 'other' } } }), { permanent: true });
  await assert.rejects(t.ingest({ ...n, receipt: { ...n.receipt, action: { ...n.receipt.action, objectKey: '../secrets' } } }), { permanent: true });
});

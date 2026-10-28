import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMailbox } from '../mail/mailbox.mjs';
import { createSender } from '../mail/send.mjs';
import { parseMessage } from '../mail/parse.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { bucket, mailFixture } from './helpers/mail-fixture.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'local PostgreSQL is not installed';

async function setup() {
  const f = await mailFixture(db), mailbox = createMailbox({ pool: db.pool, objects: f.objects }), calls = [];
  const ses = { failure: null, async sendRaw(request) { calls.push(request); if (ses.failure) throw ses.failure; return { messageId: `ses-${calls.length}` }; } };
  const sender = createSender({ pool: db.pool, objects: f.objects, ses, mailbox, bucket, configurationSet: 'inbox', now: f.now });
  const send = (options = {}) => sender.send({ mailbox: 'info@example.com', attemptId: randomUUID(), to: ['client@example.net'], subject: 'Proposal', text: 'Here is the proposal', ...options });
  return { ...f, mailbox, sender, ses, calls, send };
}

test('a send is recorded in Sent before SES, searchable, and never repeated for the same attempt', { skip }, async () => {
  const t = await setup(), attemptId = randomUUID();
  const result = await t.send({ attemptId, cc: ['Partner@Example.net'], bcc: ['hidden@example.net'] });
  assert.equal(result.state, 'sent');
  const [call] = t.calls;
  assert.deepEqual(call.destination, { ToAddresses: ['client@example.net'], CcAddresses: ['partner@example.net'], BccAddresses: ['hidden@example.net'] });
  const raw = (await parseMessage(call.raw));
  assert.equal(raw.rfcMessageId, `<${result.messageId}@example.com>`); assert.equal(raw.from.address, 'info@example.com');
  assert.doesNotMatch(call.raw.toString(), /hidden@example\.org/);
  const sent = await t.mailbox.listThreads({ mailbox: 'info@example.com', folder: 'sent' });
  assert.deepEqual(sent.threads.map(item => [item.subject, item.read]), [['Proposal', true]]);
  const [message] = await t.mailbox.readThread({ mailbox: 'info@example.com', thread: result.threadId });
  assert.deepEqual(message.delivery, { state: 'sent', detail: null }); assert.deepEqual(message.bcc, ['hidden@example.net']);
  assert.equal((await t.mailbox.search({ mailbox: 'info@example.com', query: 'proposal' })).threads.length, 1);
  assert.equal((await t.send({ attemptId })).duplicate, true);
  assert.equal(t.calls.length, 1);
});
test('replies thread under the original with In-Reply-To and References', { skip }, async () => {
  const t = await setup();
  const [received] = await t.deliver(['info@example.com'], { messageId: '<question@example.net>', references: ['<root@example.net>'] });
  const reply = await t.send({ replyToId: received.messageId, subject: 'Re: Hello project' });
  assert.equal(reply.threadId, received.threadId);
  const headers = await parseMessage(t.calls[0].raw);
  assert.equal(headers.inReplyTo, '<question@example.net>');
  assert.deepEqual(headers.references, ['<root@example.net>', '<question@example.net>']);
  assert.equal((await t.mailbox.readThread({ mailbox: 'info@example.com', thread: received.threadId })).length, 2);
  await assert.rejects(t.send({ mailbox: 'taylor@example.com', replyToId: received.messageId }), { status: 404 });
});
test('uploads are verified; bad recipients and send-disabled aliases are refused', { skip }, async () => {
  const t = await setup(), bytes = Buffer.from('report'), key = `uploads/${t.domains.example}/${randomUUID()}`;
  await t.objects.put(key, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sent = await t.send({ attachments: [{ key, name: 'r.txt', type: 'text/plain', size: bytes.length, sha256 }] });
  assert.deepEqual((await t.mailbox.readThread({ mailbox: 'info@example.com', thread: sent.threadId }))[0].attachments.map(item => item.name), ['r.txt']);
  await assert.rejects(t.send({ attachments: [{ key, name: 'r.txt', size: bytes.length, sha256: '0'.repeat(64) }] }), { status: 400 });
  await assert.rejects(t.send({ attachments: [{ key: `uploads/${t.domains.exampleorg}/x`, size: 1, sha256 }] }), { status: 400 });
  await assert.rejects(t.send({ to: ['not an address'] }), { status: 400 });
  await assert.rejects(t.send({ to: [] }), { status: 400 });
  await assert.rejects(t.send({ subject: 'two\nlines' }), { status: 400 });
  await db.pool.query("UPDATE mail.aliases SET send_enabled=false WHERE address='info@example.com'");
  await assert.rejects(t.send(), { status: 403 });
  assert.equal(t.calls.length, 1);
});
test('definite SES rejections fail; unknown outcomes are uncertain and never retried', { skip }, async () => {
  const t = await setup();
  t.ses.failure = Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' });
  assert.equal((await t.send()).state, 'failed');
  t.ses.failure = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
  const uncertain = await t.send();
  assert.equal(uncertain.state, 'uncertain'); assert.match(uncertain.detail, /Check Sent/);
  assert.equal(t.calls.length, 2);
});
test('delivery events advance status; a late delay never downgrades it', { skip }, async () => {
  const t = await setup(), sent = await t.send(), ses = { mail: { messageId: 'ses-1' } };
  const state = async () => (await t.mailbox.readThread({ mailbox: 'info@example.com', thread: sent.threadId }))[0].delivery.state;
  await t.sender.recordEvent({ eventType: 'Delivery', ...ses });
  await t.sender.recordEvent({ eventType: 'DeliveryDelay', ...ses });
  assert.equal(await state(), 'delivered');
  await t.sender.recordEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'client@example.net' }] }, ...ses });
  assert.equal(await state(), 'bounced');
  assert.deepEqual(await t.sender.recordEvent({ eventType: 'Delivery', mail: { messageId: 'someone-else' } }), { ignored: true });
});

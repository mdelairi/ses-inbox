import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { createWorker } from '../mail/worker.mjs';
import { createMailApi } from '../mail/api.mjs';
import { createPush } from '../mail/push.mjs';
import { parseMessage } from '../mail/parse.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { bucket, mailFixture } from './helpers/mail-fixture.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'local PostgreSQL is not installed';
const vapid = async () => ({ publicKey: 'public-key', privateKey: 'private-key', subject: 'mailto:owner@example.net' });
const subscription = (host = 'web.push.apple.com', id = randomUUID()) => ({ endpoint: `https://${host}/${id}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

async function setup({ sesFails } = {}) {
  const f = await mailFixture(db), sent = [], pushed = [], logs = [];
  const ses = { async sendRaw(request) { if (sesFails) throw Object.assign(new Error('rejected'), { name: 'MessageRejected' }); sent.push(request); return { messageId: `ses-${sent.length}` }; } };
  const push = createPush({ pool: db.pool, vapid, send: async (target, payload) => { pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) }); if (target.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 }); } });
  const api = createMailApi({ pool: db.pool, objects: f.objects, ses, bucket, configurationSet: 'inbox', push });
  const call = async (path, body = {}) => { const result = await api({ method: 'POST', path, body }); if (result.status !== 200) throw Object.assign(new Error(result.data.error), { status: result.status }); return result.data; };
  const worker = createWorker({ pool: db.pool, objects: f.objects, ses, bucket, configurationSet: 'inbox', push, log: line => logs.push(line), warn: line => logs.push(line) });
  async function receive(recipients, options = {}, verdicts = {}) {
    const key = `incoming/${randomUUID()}`;
    await f.objects.put(key, await new MailComposer({ from: 'Avery Quinn <avery@example.net>', to: recipients, subject: 'Workshop dates', text: 'Private body text', html: '<p>Private body text</p>', ...options }).compile().build());
    const notification = { notificationType: 'Received', mail: { messageId: `ses-${key}`, timestamp: new Date().toISOString() },
      receipt: { recipients, action: { type: 'S3', bucketName: bucket, objectKey: key }, spamVerdict: { status: verdicts.spam || 'PASS' }, virusVerdict: { status: 'PASS' } } };
    const record = { messageId: randomUUID(), body: JSON.stringify(notification) };
    assert.deepEqual(await worker({ Records: [record] }), { batchItemFailures: [] });
    return record;
  }
  return { f, sent, pushed, logs, call, worker, receive };
}

test('forwarding rules accept outside addresses only, at most three per receiving address', { skip }, async () => {
  const { call } = await setup();
  assert.deepEqual(await call('/api/mail/forwarding', { mailbox: 'info@example.com' }), { mailbox: 'info@example.com', targets: [] });
  assert.deepEqual((await call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['Me@Gmail.com ', 'me@gmail.com'] })).targets, ['me@gmail.com']);
  await assert.rejects(call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['taylor@example.com'] }), /outside this inbox/);
  await assert.rejects(call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org'] }), /at most 3/);
  await assert.rejects(call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['not an address'] }), /Check the address/);
  await db.pool.query("UPDATE mail.aliases SET receive_enabled=false WHERE address='taylor@example.com'");
  await assert.rejects(call('/api/mail/forwarding/save', { mailbox: 'taylor@example.com', targets: ['me@gmail.com'] }), { status: 403 });
  assert.deepEqual((await call('/api/mail/forwarding', { mailbox: 'info@example.com' })).targets, ['me@gmail.com'], 'a rejected save leaves rules unchanged');
  assert.deepEqual((await call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: [] })).targets, []);
});

test('new Inbox mail is forwarded once from the receiving address, with Reply-To and attachments; Spam and returning copies are not', { skip }, async () => {
  const { sent, logs, call, worker, receive } = await setup();
  await call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['me@gmail.com', 'team@example.net'] });
  const record = await receive(['info@example.com', 'taylor@example.com'], { attachments: [{ filename: 'notes.txt', content: 'attachment content' }] });
  assert.equal(sent.length, 2, 'one copy per target; taylor@ has no rule');
  assert.deepEqual(sent.map(item => item.destination.ToAddresses[0]).sort(), ['me@gmail.com', 'team@example.net']);
  assert.ok(sent.every(item => item.from === 'info@example.com' && item.configurationSet === 'inbox'));
  const copy = await parseMessage(sent[0].raw);
  assert.equal(copy.from.address, 'info@example.com'); assert.equal(copy.from.name, 'Avery Quinn via info@example.com');
  assert.deepEqual(copy.replyTo, [{ name: 'Avery Quinn', address: 'avery@example.net' }]);
  assert.equal(copy.subject, 'Workshop dates'); assert.match(copy.text, /Private body text/); assert.equal(copy.forwarded, true);
  assert.deepEqual(copy.attachments.map(item => [item.filename, item.content.toString()]), [['notes.txt', 'attachment content']]);
  const { rows } = await db.pool.query('SELECT state, ses_message_id FROM mail.forward_attempts ORDER BY target');
  assert.deepEqual(rows.map(row => row.state), ['sent', 'sent']); assert.ok(rows.every(row => row.ses_message_id));
  // A redelivered SES notification is already published: no second forward.
  assert.deepEqual(await worker({ Records: [record] }), { batchItemFailures: [] });
  assert.equal(sent.length, 2);
  await receive(['info@example.com'], { subject: 'Cheap pills' }, { spam: 'FAIL' });
  await receive(['info@example.com'], { subject: 'Came back', headers: { 'X-Inbox-Forwarded': 'info@example.com' } });
  assert.equal(sent.length, 2, 'Spam and copies this inbox forwarded are never forwarded');
  assert.ok(!logs.some(line => /Private body|Workshop|gmail/.test(line)), 'logs carry outcomes only');
});

test('an SES rejection is recorded on the attempt and does not fail or retry the incoming message', { skip }, async () => {
  const { call, receive, logs } = await setup({ sesFails: true });
  await call('/api/mail/forwarding/save', { mailbox: 'info@example.com', targets: ['me@gmail.com'] });
  await receive(['info@example.com']);
  const { rows } = await db.pool.query('SELECT state, detail FROM mail.forward_attempts');
  assert.deepEqual(rows, [{ state: 'failed', detail: 'MessageRejected' }]);
  assert.ok(logs.some(line => line.includes('mail-forwarded')));
});

test('devices enroll once per browser, only on known push services, and get sender and subject without body text', { skip }, async () => {
  const { pushed, call, receive } = await setup();
  assert.deepEqual(await call('/api/push/key'), { publicKey: 'public-key' });
  await assert.rejects(call('/api/push/subscribe', { subscription: subscription('attacker.example') }), /not supported/);
  await assert.rejects(call('/api/push/subscribe', { subscription: { ...subscription(), keys: { p256dh: 'short', auth: 'x' } } }), /invalid subscription/);
  const phone = subscription(), first = await call('/api/push/subscribe', { subscription: phone, label: 'iPhone' });
  assert.deepEqual(await call('/api/push/subscribe', { subscription: phone, label: 'iPhone (Home Screen)' }), first, 're-enrolling keeps one device');
  await call('/api/push/subscribe', { subscription: subscription('fcm.googleapis.com', 'gone'), label: 'Old laptop' });
  assert.deepEqual((await call('/api/push/devices')).map(item => item.label), ['iPhone (Home Screen)', 'Old laptop']);
  await receive(['info@example.com']);
  assert.equal(pushed.length, 2);
  const [notice] = pushed.map(item => item.payload);
  assert.equal(notice.title, 'Avery Quinn'); assert.equal(notice.body, 'Workshop dates');
  const url = new URL(notice.url, 'https://inbox.invalid');
  assert.equal(url.searchParams.get('domain'), 'example.com'); assert.equal(url.searchParams.get('mailbox'), 'info@example.com'); assert.match(url.searchParams.get('thread'), /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(pushed).includes('Private body'), 'no body text in notifications');
  const devices = await call('/api/push/devices');
  assert.deepEqual(devices.map(item => item.label), ['iPhone (Home Screen)'], 'gone endpoints are removed'); assert.ok(devices[0].lastSuccessAt);
  await receive(['info@example.com'], { subject: 'Spam' }, { spam: 'FAIL' });
  assert.equal(pushed.length, 2, 'Spam does not notify');
  assert.equal((await call('/api/push/test')).sent, 1);
  assert.deepEqual(await call('/api/push/remove', { id: devices[0].id }), { removed: 1 });
  assert.deepEqual(await call('/api/push/devices'), []);
});

test('without push configured, the notification routes report it instead of failing', { skip }, async () => {
  const f = await mailFixture(db), api = createMailApi({ pool: db.pool, objects: f.objects, ses: {}, bucket });
  assert.equal((await api({ method: 'POST', path: '/api/push/key', body: {} })).status, 503);
});

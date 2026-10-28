import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { createWorker, unwrap } from '../mail/worker.mjs';
import { createMailbox } from '../mail/mailbox.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { bucket, mailFixture } from './helpers/mail-fixture.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'local PostgreSQL is not installed';

test('SNS envelopes and raw deliveries unwrap to the same payload', () => {
  const payload = { notificationType: 'Received' };
  assert.deepEqual(unwrap(JSON.stringify({ Type: 'Notification', Message: JSON.stringify(payload) })), payload);
  assert.deepEqual(unwrap(JSON.stringify(payload)), payload);
});
test('the worker ingests mail, records events, drops permanent failures and retries the rest', { skip }, async () => {
  const f = await mailFixture(db), logs = [];
  const worker = createWorker({ pool: db.pool, objects: f.objects, ses: {}, bucket, log: line => logs.push(line), warn: line => logs.push(line) });
  const key = `incoming/${randomUUID()}`;
  await f.objects.put(key, await new MailComposer({ from: 'a@example.net', to: 'info@example.com', subject: 'Via worker', text: 'Hi' }).compile().build());
  const received = { notificationType: 'Received', mail: { messageId: 'ses-1', timestamp: new Date().toISOString() }, receipt: { recipients: ['info@example.com'], action: { type: 'S3', bucketName: bucket, objectKey: key } } };
  const records = [
    { messageId: 'r1', body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(received) }) },
    { messageId: 'r2', body: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'unknown' } }) },
    { messageId: 'r3', body: JSON.stringify({ ...received, receipt: { ...received.receipt, action: { ...received.receipt.action, bucketName: 'other' } } }) },
    { messageId: 'r4', body: JSON.stringify({ ...received, receipt: { ...received.receipt, action: { ...received.receipt.action, objectKey: 'incoming/missing' } } }) },
  ];
  assert.deepEqual(await worker({ Records: records }), { batchItemFailures: [{ itemIdentifier: 'r4' }] });
  const threads = await createMailbox({ pool: db.pool, objects: f.objects }).listThreads({ mailbox: 'info@example.com' });
  assert.deepEqual(threads.threads.map(item => item.subject), ['Via worker']);
  assert.ok(logs.some(line => line.includes('mail-rejected')));
  assert.ok(!logs.some(line => line.includes('Via worker')), 'logs must not contain message content');
});

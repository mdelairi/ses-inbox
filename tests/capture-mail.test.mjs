import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCapturedSender } from '../capture/producer.mjs';
import { createCaptureImporter, captureAttemptId } from '../mail/capture-import.mjs';
import { createCaptureWorker } from '../capture/worker.mjs';
import { createMailbox } from '../mail/mailbox.mjs';
import { createSender } from '../mail/send.mjs';
import { captureSources } from '../mail/capture-sources.mjs';
import { createBackup, loadBackup, restoreBackup } from '../mail/backup.mjs';
import { cleanupCaptureBuffer } from '../capture/retention.mjs';
import { startPostgres } from './helpers/postgres.mjs';
import { mailFixture, bucket } from './helpers/mail-fixture.mjs';
import { versionedObjects } from './helpers/versioned-mail-objects.mjs';
let db;
test.before(async () => { db = await startPostgres(); }); test.after(async () => { await db?.stop(); });
const topic = 'arn:aws:sns:us-east-1:222222222222:inbox-feedback';
const sources = { ...captureSources, 'exampleorg-staging': { ...captureSources['exampleorg-staging'], eventTopicArn: topic } };
async function fixture() {
  const f = await mailFixture(db), captureObjects = versionedObjects(), sends = [];
  const writer = async (key, value, reserve) => { if (reserve && (await captureObjects.listCurrent(key)).includes(key)) throw Object.assign(new Error('Exists'), { name: 'PreconditionFailed' }); await captureObjects.put(key, JSON.stringify(value)); };
  const input = { FromEmailAddress: '"ExampleOrg" <no-reply@example.org>', Destination: { ToAddresses: ['owner@example.invalid'], BccAddresses: ['hidden@example.invalid'] }, ReplyToAddresses: ['support@example.org'], ConfigurationSetName: 'exampleorg-staging-invitations', Content: { Simple: { Subject: { Data: 'Invoice workshop invitation' }, Body: { Text: { Data: 'A private invitation about next week.' }, Html: { Data: '<p>A private invitation about next week.</p><img src="cid:logo">' } }, Attachments: [{ FileName: 'notes.txt', RawContent: Buffer.from('attachment content') }, { FileName: 'inline.png', RawContent: Buffer.from([0, 1, 2, 255]), ContentType: 'image/png', ContentId: 'logo', ContentDisposition: 'INLINE' }] } } };
  const send = createCapturedSender({ source: 'exampleorg-staging', put: writer, send: async command => { sends.push(command.input); return { MessageId: 'provider-capture-1' }; } });
  const importer = createCaptureImporter({ pool: db.pool, objects: f.objects, captureObjects, bucket, sources });
  return { ...f, captureObjects, input, send, importer, sends, id: randomUUID(), mailbox: createMailbox({ pool: db.pool, objects: f.objects }) };
}
test('automated mail imports once into a read-only sender mailbox with complete content, Bcc and stage labels', async () => {
  const f = await fixture(); await f.send({ kind: 'member_invitation', input: f.input, id: f.id });
  const first = await f.importer.ingest('exampleorg-staging', f.id); const again = await f.importer.ingest('exampleorg-staging', f.id);
  assert.equal(again.duplicate, true); assert.equal(first.messageId, again.messageId);
  const aliases = await f.mailbox.aliases(), alias = aliases.find(row => row.address === 'no-reply@example.org');
  assert.equal(alias.sendEnabled, false); assert.equal(alias.receiveEnabled, false); assert.equal(alias.default, false);
  const threads = await f.mailbox.listThreads({ mailbox: alias.address, folder: 'sent', source: 'automated', environment: 'staging' });
  assert.equal(threads.threads.length, 1); assert.equal(threads.threads[0].read, true);
  assert.equal((await f.mailbox.listThreads({ mailbox: 'info@example.org', folder: 'sent' })).threads.length, 0);
  const [message] = await f.mailbox.readThread({ mailbox: alias.address, thread: threads.threads[0].thread });
  assert.match(message.html, /cid:logo/); assert.equal(message.attachments.length, 2); assert.equal(message.bcc[0], 'hidden@example.invalid'); assert.equal(message.delivery.state, 'sent');
  const part = await f.mailbox.attachment({ mailbox: alias.address, id: first.messageId, part: message.attachments.find(file => file.name === 'notes.txt').id }); assert.equal(await f.objects.get(part.key), 'attachment content');
  assert.ok((await f.mailbox.search({ mailbox: alias.address, query: '"next week"' })).ids.includes(first.messageId));
  await assert.rejects(createSender({ pool: db.pool, objects: f.objects, mailbox: f.mailbox }).send({ mailbox: alias.address, attemptId: randomUUID() }), { status: 403 });
  const backups = versionedObjects(), saved = await createBackup({ pool: db.pool, sourceObjects: { getRecoverable: key => f.objects.getBytes(key) }, backupObjects: backups, source: { bucket } });
  const loaded = await loadBackup({ backupObjects: backups, key: saved.key });
  assert.ok(loaded.manifest.objects.some(row => row.key.endsWith('/producer.json')));
  assert.equal((await restoreBackup({ backup: loaded, backupObjects: backups, latestLedger: [] })).messages, 1);
});
function event(f, type = 'Delivery') { return { eventType: type, mail: { messageId: 'provider-capture-1', sendingAccountId: '222222222222', commonHeaders: { messageId: '<actual-provider@example.net>' }, tags: { inbox_source: ['exampleorg-staging'], inbox_capture: [f.id], 'ses:configuration-set': ['exampleorg-staging-invitations'] } } }; }
test('weekly digests and marking notifications retain their classification through Sent import', async t => {
  for (const kind of ['weekly_digest', 'marking_waiting']) await t.test(kind, async () => {
    const f = await fixture();
    await f.send({ kind, input: f.input, id: f.id });
    const imported = await f.importer.ingest('exampleorg-staging', f.id);
    const threads = await f.mailbox.listThreads({ mailbox: 'no-reply@example.org', folder: 'sent', source: 'automated', environment: 'staging' });
    assert.equal(threads.threads.length, 1);
    const [message] = await f.mailbox.readThread({ mailbox: 'no-reply@example.org', thread: threads.threads[0].thread });
    assert.match(message.html, /private invitation/);
    assert.equal(message.delivery.state, 'sent');
    const producerKey = [...f.stored.keys()].find(key => key.endsWith('/producer.json'));
    assert.equal(JSON.parse(await f.objects.get(producerKey)).kind, kind);
    const { rows: [row] } = await db.pool.query('SELECT object_manifest_key FROM mail.messages WHERE message_id=$1', [imported.messageId]);
    assert.equal(JSON.parse(await f.objects.get(row.object_manifest_key)).capture.kind, kind);
  });
});
test('feedback before import, missing acknowledgement, duplicates and late interim outcomes preserve delivery status', async () => {
  const f = await fixture(); await f.send({ kind: 'member_invitation', input: f.input, id: f.id });
  await f.captureObjects.remove(`capture/exampleorg-staging/${f.id}/result.json`);
  assert.equal((await f.importer.recordEvent(event(f), topic)).state, 'delivered');
  assert.equal((await f.importer.recordEvent(event(f, 'DeliveryDelay'), topic)).state, 'delivered');
  await f.captureObjects.put(`capture/exampleorg-staging/${f.id}/result.json`, JSON.stringify({ version: 1, source: 'exampleorg-staging', id: f.id, state: 'sent', sesMessageId: 'provider-capture-1' }));
  await f.importer.ingest('exampleorg-staging', f.id);
  const [attempt] = (await db.pool.query('SELECT state, ses_message_id FROM mail.send_attempts')).rows;
  assert.equal(attempt.state, 'delivered'); assert.equal(attempt.ses_message_id, 'provider-capture-1');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.message_ids')).rows[0].n, 2);
  await assert.rejects(f.importer.recordEvent(event(f), 'arn:wrong'), /UntrustedCaptureFeedback/);
  await assert.rejects(f.importer.recordEvent({ ...event(f), mail: { ...event(f).mail, sendingAccountId: 'other' } }, topic), /UntrustedCaptureFeedback/);
});
test('permanent deletion prevents capture replay and removes replayed intake versions', async () => {
  const f = await fixture(); await f.send({ kind: 'member_invitation', input: f.input, id: f.id }); const imported = await f.importer.ingest('exampleorg-staging', f.id);
  await f.mailbox.setState({ mailbox: 'no-reply@example.org', ids: [imported.messageId], folder: 'trash' });
  await f.mailbox.deleteForever({ mailbox: 'no-reply@example.org', ids: [imported.messageId] });
  assert.equal((await f.importer.ingest('exampleorg-staging', f.id)).deleted, true);
  assert.equal((await f.captureObjects.versions(`capture/exampleorg-staging/${f.id}/`)).length, 0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.messages')).rows[0].n, 0);
  assert.ok(![...f.stored.keys()].some(key => key.endsWith('producer.json')));
});
test('trusted prefixes determine environment; forbidden sender/kind and malformed imports fail visibly', async () => {
  const f = await fixture(); await f.send({ kind: 'member_invitation', input: f.input, id: f.id });
  const key = `capture/exampleorg-staging/${f.id}/message.json`, record = JSON.parse(await f.captureObjects.get(key));
  record.request.FromEmailAddress = 'attacker@example.com'; await f.captureObjects.put(key, JSON.stringify(record));
  await assert.rejects(f.importer.ingest('exampleorg-staging', f.id), /CaptureSenderNotAllowed/);
  const worker = createCaptureWorker({ pool: db.pool, objects: f.objects, captureObjects: f.captureObjects, bucket, captureBucket: 'capture-bucket', sources, log: () => {}, warn: () => {} });
  assert.deepEqual(await worker({ Records: [{ messageId: 'bad', body: JSON.stringify({ Records: [{ eventSource: 'aws:s3', s3: { bucket: { name: 'other' }, object: { key } } }] }) }] }), { batchItemFailures: [{ itemIdentifier: 'bad' }] });
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.messages')).rows[0].n, 0);
});
test('capture buffer physically expires every version, including current and incomplete captures', async () => {
  let now = Date.now(); const objects = versionedObjects(() => now);
  await objects.put('capture/test/old/message.json', 'private'); await objects.put('capture/test/old/message.json', 'old version');
  now += 16 * 86400000; await objects.put('capture/test/new/message.json', 'new');
  assert.equal((await cleanupCaptureBuffer({ objects, now })).removed, 2);
  assert.deepEqual((await objects.listCurrent('capture/')), ['capture/test/new/message.json']);
});
test('raw MIME remains byte-exact and replay preserves a user folder change', async () => {
  const f = await fixture(), raw = Buffer.from('From: ExampleOrg <no-reply@example.org>\r\nTo: owner@example.invalid\r\nSubject: Exact raw bytes\r\nMessage-ID: <raw-capture@example.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal raw content.\r\n');
  f.input.Content = { Raw: { Data: raw } };
  await f.send({ kind: 'member_invitation', input: f.input, id: f.id });
  const imported = await f.importer.ingest('exampleorg-staging', f.id);
  const rawKey = [...f.stored.keys()].find(key => key.endsWith('/raw.eml'));
  assert.deepEqual(await f.objects.getBytes(rawKey), raw);
  await f.mailbox.setState({ mailbox: 'no-reply@example.org', ids: [imported.messageId], folder: 'archive' });
  await f.importer.ingest('exampleorg-staging', f.id);
  assert.equal((await f.mailbox.listThreads({ mailbox: 'no-reply@example.org', folder: 'sent' })).threads.length, 0);
  assert.equal((await f.mailbox.listThreads({ mailbox: 'no-reply@example.org', folder: 'archive' })).threads.length, 1);
});
test('authentication classifications are rejected even when placed in a trusted intake prefix', async () => {
  const f = await fixture(); await f.send({ kind: 'member_invitation', input: f.input, id: f.id });
  const key = `capture/exampleorg-staging/${f.id}/message.json`, record = JSON.parse(await f.captureObjects.get(key));
  record.kind = 'signup_code'; await f.captureObjects.put(key, JSON.stringify(record));
  await assert.rejects(f.importer.ingest('exampleorg-staging', f.id), /InvalidCaptureRecord/);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.messages')).rows[0].n, 0);
});

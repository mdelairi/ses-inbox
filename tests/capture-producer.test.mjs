import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCapturedSender } from '../capture/producer.mjs';
const input = () => ({ FromEmailAddress: '"ExampleOrg" <no-reply@example.org>', Destination: { ToAddresses: ['owner@example.invalid'], BccAddresses: ['hidden@example.invalid'] }, ReplyToAddresses: ['support@example.org'], ConfigurationSetName: 'exampleorg-staging-invitations', EmailTags: [{ Name: 'invitation', Value: 'existing' }], Content: { Simple: { Subject: { Data: '[STAGING] Invitation', Charset: 'UTF-8' }, Body: { Text: { Data: 'Original invitation link', Charset: 'UTF-8' }, Html: { Data: '<p>Original invitation link</p>' } }, Attachments: [{ FileName: 'a.bin', RawContent: Buffer.from([0, 255, 1]) }] } } });
function setup() {
  const records = new Map(), sent = [], logs = [];
  const put = async (key, value, reserve) => { if (reserve && records.has(key)) throw Object.assign(new Error('Exists'), { name: 'PreconditionFailed' }); records.set(key, structuredClone(value)); };
  const send = async (command, options) => { sent.push({ input: command.input, options }); return { MessageId: 'provider-1' }; };
  return { records, sent, logs, put, send, capture: createCapturedSender({ source: 'exampleorg-staging', put, send, warn: line => logs.push(line) }) };
}
test('producer preserves recipients, Reply-To, content, configuration, existing tags and caller result', async () => {
  const t = setup(), message = input(), original = structuredClone(message), options = { abortSignal: AbortSignal.timeout(10000) }, id = randomUUID();
  const result = await t.capture({ kind: 'member_invitation', input: message, options, id });
  assert.equal(result.MessageId, 'provider-1'); assert.equal(t.sent.length, 1);
  const wire = t.sent[0].input;
  for (const key of ['FromEmailAddress', 'Destination', 'ReplyToAddresses', 'ConfigurationSetName', 'Content']) assert.deepEqual(wire[key], message[key]);
  assert.deepEqual(wire.EmailTags.slice(0, 1), original.EmailTags); assert.equal(wire.EmailTags.find(tag => tag.Name === 'inbox_capture').Value, id);
  assert.equal(t.sent[0].options, options); assert.deepEqual(structuredClone(message), original);
  const prepared = [...t.records].find(([key]) => key.endsWith('/message.json'))[1];
  assert.equal(prepared.request.Content.Simple.Attachments[0].RawContent, 'AP8B'); assert.equal(prepared.request.Destination.BccAddresses[0], 'hidden@example.invalid');
  await assert.rejects(t.capture({ kind: 'member_invitation', input: message, id }), { message: 'CaptureAlreadyAttempted', notSent: false });
  assert.equal(t.sent.length, 1);
});
test('verification and reset mail bypass storage and correlation tags; unknown classifications are refused', async () => {
  const t = setup();
  for (const kind of ['signup_code', 'verification', 'password_reset', 'verification_code']) await t.capture({ kind, input: input() });
  assert.equal(t.records.size, 0); assert.equal(t.sent.length, 4);
  assert.ok(t.sent.every(row => !row.input.EmailTags.some(tag => tag.Name === 'inbox_capture')));
  await assert.rejects(t.capture({ kind: 'unclassified', input: input() }), /CaptureKindRequired/);
});
test('capture failure stops before SES; post-acceptance status failure never changes acceptance', async () => {
  let sends = 0; const logs = [];
  const failBefore = createCapturedSender({ source: 'exampleorg-staging', put: async () => { throw new Error('StorageDown'); }, send: async () => { sends++; } });
  await assert.rejects(failBefore({ kind: 'member_invitation', input: input() }), { name: 'CaptureBeforeSendError', notSent: true }); assert.equal(sends, 0);
  const accepted = { MessageId: 'accepted', metadata: 'unchanged' };
  const failAfter = createCapturedSender({ source: 'exampleorg-staging', put: async key => { if (key.endsWith('/result.json')) throw new Error('StorageDown'); }, send: async () => accepted, warn: line => logs.push(line) });
  assert.equal(await failAfter({ kind: 'member_invitation', input: input() }), accepted);
  assert.match(logs[0], /capture-status-write-failed/); assert.doesNotMatch(logs[0], /owner@|Original invitation link|hidden@/);
});
test('definite rejection versus timeout is stored, and the exact provider error is rethrown', async () => {
  for (const [name, state] of [['MessageRejected', 'failed'], ['TimeoutError', 'uncertain']]) {
    const error = Object.assign(new Error('Do not log content'), { name }), rows = [];
    const send = createCapturedSender({ source: 'exampleorg-staging', put: async (key, value) => rows.push([key, value]), send: async () => { throw error; } });
    await assert.rejects(send({ kind: 'member_invitation', input: input() }), value => value === error);
    assert.equal(rows.at(-1)[1].state, state); assert.ok(!JSON.stringify(rows).includes('Do not log content'));
  }
});
test('unsupported content fails before capture and SES with a definite not-sent outcome', async () => {
  const t = setup(), message = input();
  message.Content = { Template: { TemplateName: 'not-a-complete-message' } };
  await assert.rejects(t.capture({ kind: 'member_invitation', input: message }), { name: 'CaptureBeforeSendError', notSent: true });
  assert.equal(t.records.size, 0); assert.equal(t.sent.length, 0);
});

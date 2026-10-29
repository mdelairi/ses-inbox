// Exercise proposed producer edits in an ignored local review copy. Never edit or
// deploy either external checkout. AWS clients are recorders; no email is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const available = existsSync('~/DEV/exampleorg/library/server/learning-mail.mjs');
const skip = !available && 'ExampleOrg source checkout is unavailable';
let invitation, learning, originalInvitation, originalLearning;
let producerS3;
const output = new URL('../.audit/producer-contracts/', import.meta.url);
const root = new URL('../', import.meta.url);
test.before(async () => {
  if (!available) return;
  execFileSync(process.execPath, ['scripts/prepare-producer-patches.mjs'], { cwd: root, stdio: 'pipe' });
  await mkdir(new URL('inbox-capture/', output), { recursive: true });
  await mkdir(new URL('../shared/', output), { recursive: true });
  await cp(new URL('../capture/producer.mjs', import.meta.url), new URL('inbox-capture/producer.mjs', output));
  await cp(new URL('../capture/protocol.mjs', import.meta.url), new URL('inbox-capture/protocol.mjs', output));
  await cp(new URL('../integrations/exampleorg-inbox-capture.mjs', import.meta.url), new URL('inbox-capture.mjs', output));
  await writeFile(new URL('../shared/outcomes.mjs', output), "export { minutesLabel } from '~/DEV/exampleorg/library/shared/outcomes.mjs';\n");
  await writeFile(new URL('digests.mjs', output), "export { DIGEST, DIGEST_NOTE, MARKING, answersLabel, weekLabel } from '~/DEV/exampleorg/library/server/digests.mjs';\n");
  const manifest = JSON.parse(await readFile(new URL('../integrations/producer-patches/manifest.json', import.meta.url)));
  const applied = manifest.edits.filter(entry => entry.project === 'exampleorg' && entry.path.startsWith('library/server/')).every(entry => entry.applied);
  for (const file of ['invitation-mail', 'learning-mail']) {
    const text = await readFile(new URL(`../.audit/producer-review/exampleorg-library_server_${file}.mjs.after`, import.meta.url));
    await writeFile(new URL(`${file}.mjs`, output), text);
    await cp(new URL(`../.audit/producer-review/exampleorg-library_server_${file}.mjs.before`, import.meta.url), new URL(`baseline-${file}.mjs`, output));
  }
  invitation = await import(applied ? '~/DEV/exampleorg/library/server/invitation-mail.mjs' : new URL('invitation-mail.mjs', output));
  learning = await import(applied ? '~/DEV/exampleorg/library/server/learning-mail.mjs' : new URL('learning-mail.mjs', output));
  producerS3 = applied ? createRequire('~/DEV/exampleorg/package.json')('@aws-sdk/client-s3').S3Client : S3Client;
  originalInvitation = await import(new URL('baseline-invitation-mail.mjs', output));
  originalLearning = await import(new URL('baseline-learning-mail.mjs', output));
});
function harness(t) {
  const old = { bucket: process.env.INBOX_CAPTURE_BUCKET, source: process.env.INBOX_CAPTURE_SOURCE };
  process.env.INBOX_CAPTURE_BUCKET = 'review-only-no-real-aws'; process.env.INBOX_CAPTURE_SOURCE = 'exampleorg-staging';
  t.after(() => { for (const [name, value] of [['INBOX_CAPTURE_BUCKET', old.bucket], ['INBOX_CAPTURE_SOURCE', old.source]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const writes = [], sent = [], originalSent = [];
  t.mock.method(producerS3.prototype, 'send', async command => { writes.push(command.input); return {}; });
  const client = { send: async command => { sent.push(command.input); return { MessageId: 'provider-proof' }; } };
  const originalClient = { send: async command => { originalSent.push(command.input); return { MessageId: 'provider-proof' }; } };
  const configuration = { environment: 'staging', region: 'us-east-1', frontendOrigin: 'https://exampleorg.example.invalid', onboarding: { emailEnabled: true, replyTo: 'support@example.org', configurationSet: 'exampleorg-staging-invitations', allowedRecipients: ['owner@example.invalid'] } };
  const repo = { invitationSuppressed: async () => false, composeEmail: async values => ({ subject: 'Unchanged subject', text: `Exact text ${values.action?.url}`, html: `<p>Exact HTML ${values.action?.url}</p>` }) };
  function sameDelivery() {
    assert.equal(sent.length, 1); assert.equal(originalSent.length, 1);
    const normalized = { ...sent[0], EmailTags: sent[0].EmailTags.filter(tag => !['inbox_capture', 'inbox_source'].includes(tag.Name)) };
    assert.deepEqual(normalized, originalSent[0]);
    assert.equal(writes.length, 2); assert.equal(writes[0].IfNoneMatch, '*');
    const record = JSON.parse(writes[0].Body);
    assert.deepEqual(record.request.Content, originalSent[0].Content);
  }
  return { writes, sent, originalSent, client, originalClient, configuration, repo, sameDelivery };
}
test('proposed membership invitation preserves exact SES payload and source delivery result', { skip }, async t => {
  const h = harness(t), i = { id: randomUUID(), generation: 1, expiresAt: '2026-12-01T12:00:00Z', role: 'admin', companyId: randomUUID() };
  let reserved = false;
  Object.assign(h.repo, { beginInvitationDelivery: async () => { if (reserved) return false; reserved = true; return true; }, finishInvitationDelivery: async (_id, _generation, state) => ({ ...i, deliveryState: state }), deliveryState: async () => ({}) });
  const value = { invitation: i, delivery: { email: 'owner@example.invalid', secret: 'private-invitation-token', companyName: 'Example' } };
  const revised = invitation.invitationMailer({ ...h, repo: h.repo, client: h.client });
  const result = await revised(value); assert.equal(result.invitation.deliveryState, 'accepted');
  await revised(value); assert.equal(h.sent.length, 1, 'existing generation reservation prevents another provider call');
  reserved = false;
  await originalInvitation.invitationMailer({ repo: h.repo, configuration: h.configuration, client: h.originalClient })(value);
  h.sameDelivery();
});
test('proposed learning integrations preserve provider requests and classify each ordinary message correctly', { skip }, async t => {
  for (const [kind, expected] of [['assigned', 'course_assigned'], ['before', 'due_reminder'], ['overdue-1', 'overdue_reminder'], ['overdue-2', 'overdue_reminder'], ['overdue-3', 'overdue_reminder'], ['weekly_digest', 'weekly_digest'], ['marking_waiting', 'marking_waiting']]) await t.test(kind, async t => {
    const h = harness(t), value = { to: 'owner@example.invalid', kind, due: '2026-12-01', week: '2026-11-30', count: 2, cards: [{ title: 'Completed', lines: ['2 courses completed'] }], company: 'Example', course: 'Learning', link: 'https://exampleorg.example.invalid/course/' };
    assert.equal((await learning.learningMailer({ repo: h.repo, configuration: h.configuration, client: h.client })(value)).state, 'accepted');
    await originalLearning.learningMailer({ repo: h.repo, configuration: h.configuration, client: h.originalClient })(value);
    h.sameDelivery();
    assert.equal(JSON.parse(h.writes[0].Body).kind, expected);
  });
});
test('proposed course invitation preserves its link, recipient and existing tags', { skip }, async t => {
  const h = harness(t), value = { id: randomUUID(), email: 'owner@example.invalid', secret: 'private-course-token', expiresAt: '2026-12-01T12:00:00Z', companyName: 'Example', courseTitle: 'Learning' };
  assert.equal(await learning.courseInvitationMailer({ repo: h.repo, configuration: h.configuration, client: h.client })(value, 'https://exampleorg.example.invalid'), 'accepted');
  await originalLearning.courseInvitationMailer({ repo: h.repo, configuration: h.configuration, client: h.originalClient })(value, 'https://exampleorg.example.invalid');
  h.sameDelivery();
});
test('unclassified future learning messages retain delivery without a false capture classification', { skip }, async t => {
  const h = harness(t), value = { to: 'owner@example.invalid', kind: 'future_notice', due: '2026-12-01', company: 'Example', course: 'Learning', link: 'https://exampleorg.example.invalid/course/' };
  assert.equal((await learning.learningMailer({ repo: h.repo, configuration: h.configuration, client: h.client })(value)).state, 'accepted');
  await originalLearning.learningMailer({ repo: h.repo, configuration: h.configuration, client: h.originalClient })(value);
  assert.deepEqual(h.sent, h.originalSent);
  assert.equal(h.writes.length, 0);
});
test('applied producer mailers record capture outages as definite pre-send failures', { skip }, async t => {
  const h = harness(t);
  t.mock.method(producerS3.prototype, 'send', async () => { throw new Error('MockCaptureOutage'); });
  t.mock.method(console, 'warn', () => {});
  const reminder = { to: 'owner@example.invalid', kind: 'assigned', company: 'Example', course: 'Learning', link: 'https://exampleorg.example.invalid/course/' };
  assert.equal((await learning.learningMailer({ repo: h.repo, configuration: h.configuration, client: h.client })(reminder)).state, 'failed');
  const i = { id: randomUUID(), generation: 1, expiresAt: '2026-12-01T12:00:00Z', role: 'admin', companyId: randomUUID() };
  Object.assign(h.repo, { beginInvitationDelivery: async () => true, finishInvitationDelivery: async () => i, deliveryState: async () => ({}) });
  const result = await invitation.invitationMailer({ repo: h.repo, configuration: h.configuration, client: h.client })({ invitation: i, delivery: { email: 'owner@example.invalid', secret: 'private-invitation-token', companyName: 'Example' } });
  assert.equal(result.invitation.deliveryState, 'failed');
  assert.equal(h.sent.length, 0);
});
test('generic sign-up-code sending bypasses capture; production sending stays disabled', { skip }, async t => {
  const h = harness(t), value = { to: 'owner@example.invalid', email: { subject: 'Your sign-up code', text: '123456', html: '<p>123456</p>' } };
  await learning.emailSender({ repo: h.repo, configuration: h.configuration, client: h.client })(value);
  await originalLearning.emailSender({ repo: h.repo, configuration: h.configuration, client: h.originalClient })(value);
  assert.deepEqual(h.sent[0], h.originalSent[0]); assert.equal(h.writes.length, 0);
  const production = { ...h.configuration, environment: 'production', onboarding: undefined };
  assert.equal((await learning.emailSender({ repo: h.repo, configuration: production, client: h.client })(value)).state, 'skipped');
  assert.equal(h.sent.length, 1); assert.equal(h.writes.length, 0);
});

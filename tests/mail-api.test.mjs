import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMailApi } from '../mail/api.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { bucket, mailFixture } from './helpers/mail-fixture.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'local PostgreSQL is not installed';

async function setup() {
  const f = await mailFixture(db), calls = [];
  const ses = { async sendRaw(request) { calls.push(request); return { messageId: `ses-${calls.length}` }; } };
  const api = createMailApi({ pool: db.pool, objects: f.objects, ses, bucket, configurationSet: 'inbox', now: f.now });
  const call = async (path, body = {}) => { const result = await api({ method: 'POST', path, body }); if (result.status !== 200) throw Object.assign(new Error(result.data.error), { status: result.status }); return result.data; };
  return { ...f, api, call, calls };
}

test('drafts save with compare-and-swap, list per alias, and are removed after sending', { skip }, async () => {
  const t = await setup(), id = randomUUID(), mailbox = 'info@example.com';
  const content = Buffer.from('plan'), sha256 = createHash('sha256').update(content).digest('hex');
  const { key } = await t.call('/api/mail/upload', { mailbox, sha256, size: content.length });
  await t.objects.put(key, content);
  const draft = { to: ['client@example.net'], subject: 'Plan', text: 'Draft body', attachments: [{ key, name: 'plan.txt', type: 'text/plain', size: content.length, sha256 }] };
  const first = await t.call('/api/mail/draft/save', { mailbox, id, revision: 0, draft });
  const second = await t.call('/api/mail/draft/save', { mailbox, id, revision: first.revision, draft: { ...draft, text: 'Edited' } });
  await assert.rejects(t.call('/api/mail/draft/save', { mailbox, id, revision: first.revision, draft }), { status: 409 });
  assert.equal((await t.call('/api/mail/draft', { mailbox, id })).draft.text, 'Edited');
  assert.deepEqual((await t.call('/api/mail/drafts', { mailbox })).map(item => [item.subject, item.revision]), [['Plan', second.revision]]);
  assert.deepEqual(await t.call('/api/mail/drafts', { mailbox: 'taylor@example.com' }), []);
  assert.equal([...t.stored.keys()].filter(key => key.startsWith('drafts/')).length, 1);
  const sent = await t.call('/api/mail/send', { mailbox, attemptId: randomUUID(), draftId: id, ...draft });
  assert.equal(sent.state, 'sent');
  assert.deepEqual(await t.call('/api/mail/drafts', { mailbox }), []);
  assert.deepEqual([...t.stored.keys()].filter(key => /^(drafts|uploads)\//.test(key)), [], 'sending removes the draft and its uploads');
});
test('entries list every alias with metadata; search reports matched ids; drafts keep typed recipients', { skip }, async () => {
  const t = await setup();
  const [shared] = await t.deliver(['info@example.com', 'taylor@example.com'], { subject: 'Shared quote' });
  await t.deliver(['info@example.org'], { subject: 'Other domain' });
  const { entries, truncated } = await t.call('/api/mail/entries');
  assert.equal(truncated, false);
  assert.deepEqual(entries.map(item => `${item.mailbox}:${item.subject}`).sort(), ['info@example.com:Shared quote', 'info@example.org:Other domain', 'taylor@example.com:Shared quote']);
  assert.equal(entries.find(item => item.mailbox === 'info@example.com').domain, 'example.com');
  assert.equal('text' in entries[0], false);
  assert.deepEqual((await t.call('/api/mail/search', { mailbox: 'info@example.com', query: 'quote' })).ids, [shared.messageId]);
  const id = randomUUID();
  await t.call('/api/mail/draft/save', { mailbox: 'info@example.com', id, revision: 0, draft: { to: 'half-typed@exa', subject: 'x' } });
  assert.equal((await t.call('/api/mail/draft', { mailbox: 'info@example.com', id })).draft.to, 'half-typed@exa');
  await assert.rejects(t.call('/api/mail/upload/download', { mailbox: 'info@example.com', key: `uploads/${t.domains.exampleorg}/x` }), { status: 404 });
  assert.match((await t.call('/api/mail/upload/download', { mailbox: 'info@example.com', key: `uploads/${t.domains.example}/x` })).url, /uploads/);
});
test('uploads, attachment links and routing errors', { skip }, async () => {
  const t = await setup(), bytes = Buffer.from('file'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await t.call('/api/mail/upload', { mailbox: 'info@example.com', sha256, size: bytes.length });
  assert.match(ticket.key, new RegExp(`^uploads/${t.domains.example}/[0-9a-f-]{36}/${sha256}$`));
  await assert.rejects(t.call('/api/mail/upload', { mailbox: 'info@example.com', sha256, size: 26 * 1024 * 1024 }), { status: 400 });
  const [delivery] = await t.deliver(['info@example.com'], { attachments: [{ filename: 'a.txt', content: 'abc' }] });
  const link = await t.call('/api/mail/attachment', { mailbox: 'info@example.com', id: delivery.messageId, part: '0' });
  assert.equal(link.name, 'a.txt'); assert.match(link.url, /parts\/0$/);
  assert.deepEqual((await t.api({ method: 'POST', path: '/api/mail/nope', body: {} })).status, 404);
  assert.deepEqual((await t.api({ method: 'GET', path: '/api/mail/threads' })).status, 405);
  assert.equal((await t.call('/api/mail/mailboxes')).length, 4);
  assert.equal((await t.call('/api/mail/threads', { mailbox: 'info@example.com' })).threads.length, 1);
});

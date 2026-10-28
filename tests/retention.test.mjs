import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedState } from '../web/fixtures.mjs';
import { createMailApi } from '../stage/mail-api.mjs';
import { DAY, hash, fileKeys } from '../stage/retention.mjs';
import { reconcileOwner, recoverMissing } from '../stage/maintenance.mjs';
import { memoryStore } from './helpers/retention-memory.mjs';

async function fixture() {
  let time = Date.parse('2026-10-28T00:00:00Z');
  const owner = hash('fixture-owner'), store = memoryStore(() => time), api = createMailApi({ ...store, now: () => time });
  const bytes = Buffer.from('file contents'), sha256 = hash(bytes), key = `samples/${owner}/files/${randomUUID()}/${sha256}`;
  await store.objects.writeBytes(key, bytes);
  const state = seedState(); state.messages = [{ ...state.messages[0], id: 'retained-message', domain: 'example.org', from: 'sender@example.net', to: ['info@example.org', 'support@example.org'], date: '2000-01-01T00:00:00Z', mailboxes: { 'info@example.org': { folder: 'trash', read: true }, 'support@example.org': { folder: 'spam', read: false } }, attachments: [{ id: 'file', name: 'file.txt', type: 'text/plain', size: bytes.length, objectKey: key, sha256 }] }];
  const save = async (value, revision) => api({ method: 'PUT', path: '/api/state', sub: 'fixture-owner', body: { state: value, revision, writeId: randomUUID() } });
  const read = async () => (await api({ method: 'GET', path: '/api/state', sub: 'fixture-owner' })).data;
  await save(state, 0);
  const original = await store.heads.get(owner), versionId = (await store.objects.versions(owner, original.objectKey)).find(value => !value.deleteMarker).versionId;
  return { ...store, api, owner, key, bytes, state, save, read, original, versionId, setTime: value => { time = value; }, now: () => time };
}
test('old Trash/Spam, shared alias copies and live attachments never expire', async () => {
  const f = await fixture();
  delete f.state.messages[0].mailboxes['info@example.org']; await f.save(f.state, 1);
  await reconcileOwner({ ...f, now: f.now() + 100 * DAY });
  assert.equal((await f.objects.head(f.key)).size, f.bytes.length);
  assert.deepEqual(Object.keys((await f.read()).state.messages[0].mailboxes), ['support@example.org']);
  const restored = structuredClone(f.state); restored.messages[0].mailboxes['info@example.org'] = { folder: 'inbox', read: false };
  await assert.rejects(f.save(restored, 2), { status: 409 });
});
test('restore masks permanent alias deletion, keeps another alias and preserves current edits', async () => {
  const f = await fixture(); delete f.state.messages[0].mailboxes['info@example.org']; f.state.domains[0].name = 'Current name'; await f.save(f.state, 1);
  const report = await recoverMissing({ ...f, objectKey: f.original.objectKey, versionId: f.versionId, expectedRevision: 2, apply: true, now: f.now() + DAY });
  assert.equal(report.blockedMailboxCopies, 1);
  const current = await f.read(); assert.equal(current.state.domains[0].name, 'Current name'); assert.deepEqual(Object.keys(current.state.messages[0].mailboxes), ['support@example.org']);
  assert.equal((await f.heads.tombstones(f.owner)).length, 1);
});
test('last-reference deletion retires files; orphan uploads get a grace period; all expired versions are purged', async () => {
  const f = await fixture(); f.state.messages = []; await f.save(f.state, 1);
  await reconcileOwner({ ...f, now: f.now() + DAY });
  await assert.rejects(f.objects.head(f.key));
  assert.ok((await f.objects.versions(f.owner, f.key)).some(value => !value.deleteMarker));
  const orphan = `samples/${f.owner}/files/${randomUUID()}/${hash('unused')}`; await f.objects.writeBytes(orphan, Buffer.from('unused'));
  await reconcileOwner({ ...f, now: f.now() + DAY - 1 }); assert.equal((await f.objects.head(orphan)).size, 6);
  await reconcileOwner({ ...f, now: f.now() + DAY + 1 }); await assert.rejects(f.objects.head(orphan));
  await reconcileOwner({ ...f, now: f.now() + 29 * DAY - 1 }); assert.ok((await f.objects.versions(f.owner, f.key)).length);
  // Even a late replay into an already retired key cannot extend its deadline.
  await f.objects.writeBytes(f.key, f.bytes);
  await reconcileOwner({ ...f, now: f.now() + 29 * DAY });
  assert.equal((await f.objects.versions(f.owner, f.key)).length, 0); assert.equal((await f.objects.versions(f.owner, orphan)).length, 0);
  assert.equal((await f.read()).state.messages.length, 0);
  await assert.rejects(recoverMissing({ ...f, objectKey: f.original.objectKey, versionId: f.versionId, expectedRevision: 2, apply: true, now: f.now() + 29 * DAY }), /ExpiredOrUnverified/);
});
test('a corrupt live snapshot requires explicit repair; restored files receive fresh keys', async () => {
  const f = await fixture(); await f.save(f.state, 1);
  const corrupt = await f.heads.get(f.owner); await f.objects.write(corrupt.objectKey, 'corrupt');
  const options = { ...f, objectKey: f.original.objectKey, versionId: f.versionId, expectedRevision: 2, now: f.now() + DAY };
  assert.equal((await recoverMissing(options)).unreadableCurrent, true);
  await assert.rejects(recoverMissing({ ...options, apply: true }), /ExplicitUnreadableRepairRequired/);
  await recoverMissing({ ...options, apply: true, repairUnreadable: true });
  const state = (await f.read()).state, fresh = [...fileKeys(state)][0];
  assert.notEqual(fresh, f.key); assert.equal((await f.objects.head(fresh)).sha256, hash(f.bytes));
  await reconcileOwner({ ...f, now: f.now() + 100 * DAY }); assert.equal((await f.objects.head(fresh)).size, f.bytes.length);
});
test('failed purge keeps its retirement fence and retry completes without touching live files', async () => {
  const f = await fixture(); f.state.messages = []; await f.save(f.state, 1);
  const purge = f.objects.purge; f.objects.purge = async () => { throw new Error('NetworkFailure'); };
  await assert.rejects(reconcileOwner({ ...f, now: f.now() + 30 * DAY }), /NetworkFailure/);
  assert.ok((await f.heads.retired(f.owner)).some(item => item.objectKey === f.key));
  assert.equal((await f.heads.get(f.owner)).maintenanceToken, null);
  f.objects.purge = purge; await reconcileOwner({ ...f, now: f.now() + 30 * DAY });
  assert.equal((await f.objects.versions(f.owner, f.key)).length, 0);
});
test('cleanup lock blocks publication and cross-owner recovery is rejected', async () => {
  const f = await fixture(); await f.heads.claim(f.owner, 'held');
  await assert.rejects(f.save(f.state, 1), { status: 409 });
  await f.heads.release(f.owner, 'held');
  await assert.rejects(recoverMissing({ ...f, owner: hash('other'), objectKey: f.original.objectKey, versionId: f.versionId, expectedRevision: 1 }), /InvalidRecoverySource/);
});

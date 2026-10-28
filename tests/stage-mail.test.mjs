import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMailApi, validateState } from '../stage/mail-api.mjs';
import { createStageHandler, hash, sessionCookie } from '../stage/auth.mjs';
import { seedState } from '../web/fixtures.mjs';
import { withoutDeleted } from '../stage/retention.mjs';

const owner = hash('owner-sub');
function setup() {
  const data = new Map(), blobs = new Map();
  const objects = {
    async read(key) { return blobs.get(key); }, async write(key, value) { blobs.set(key, value); }, async remove(key) { blobs.delete(key); },
    async downloadUrl(key) { return `https://objects.invalid/${key}`; }, async head(key) { return { size: 3, sha256: key.split('/').at(-1) }; },
    async uploadUrl() { return { url: 'https://objects.invalid/upload', headers: {} }; },
  };
  const heads = { tombstones: async () => [], retired: async () => [], async get(key) { return data.get(key); }, async compareAndSwap(key, revision, next) { if ((data.get(key)?.revision || 0) !== revision) return false; data.set(key, next); return true; } };
  return { api: createMailApi({ heads, objects }), data, blobs, objects, heads };
}
const save = (api, state, revision = 0, writeId = '12345678-1234-1234-1234-123456789abc') => api({ method: 'PUT', path: '/api/state', sub: 'owner-sub', body: { revision, writeId, state } });
test('shared state persists and stale devices cannot replace newer data; retry is idempotent', async () => {
  const { api, data, blobs } = setup(), state = seedState();
  assert.equal((await save(api, state)).data.revision, 1);
  const read = await api({ method: 'GET', path: '/api/state', sub: 'owner-sub' });
  assert.equal(read.data.revision, 1); assert.deepEqual(read.data.state, withoutDeleted(state, []));
  assert.equal((await save(api, state)).data.revision, 1);
  await assert.rejects(save(api, { ...state, drafts: [] }, 0, 'different-write-123456'), { status: 409 });
  assert.equal(data.get(owner).revision, 1); assert.equal(blobs.size, 1);
});
test('snapshot reads retry a concurrently retired key and keep body and revision together', async () => {
  const fixture = setup(), state = seedState(); await save(fixture.api, state);
  const originalRead = fixture.objects.read; let retire = true;
  fixture.objects.read = async key => {
    if (retire) {
      retire = false;
      const newer = structuredClone(state); newer.domains[0].name = 'Newer workspace';
      await save(fixture.api, newer, 1, 'newer-write-123456789');
      const error = new Error('Retired snapshot without ListBucket permission'); error.name = 'AccessDenied'; throw error;
    }
    return originalRead(key);
  };
  const result = await fixture.api({ method: 'GET', path: '/api/state', sub: 'owner-sub' });
  assert.equal(result.data.revision, 2); assert.equal(result.data.state.domains[0].name, 'Newer workspace');
});
test('concurrent writes accept one version and remove only the losing state object', async () => {
  const { api, data, blobs } = setup();
  const results = await Promise.allSettled([save(api, seedState()), save(api, seedState(), 0, 'different-write-123456')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(data.get(owner).revision, 1); assert.equal(blobs.size, 1);
});
test('unknown commit outcome preserves a potentially published object', async () => {
  const fixture = setup(); fixture.heads.compareAndSwap = async () => { throw new Error('TransportInterrupted'); };
  await assert.rejects(save(fixture.api, seedState()), /TransportInterrupted/);
  assert.equal(fixture.blobs.size, 1);
});
test('file references enforce owner scope, size and checksum, and removed files cannot be re-signed', async () => {
  const fixture = setup(), state = seedState(), sha256 = 'a'.repeat(64), key = `samples/${owner}/files/${sha256}`;
  state.messages[0].attachments = [{ id: 'file', name: 'file.txt', size: 3, type: 'text/plain', objectKey: key, sha256 }];
  await save(fixture.api, state);
  assert.equal((await fixture.api({ method: 'POST', path: '/api/files/download', sub: 'owner-sub', body: { objectKey: key } })).status, 200);
  await assert.rejects(fixture.api({ method: 'POST', path: '/api/files/download', sub: 'other-owner', body: { objectKey: key } }), { status: 404 });
  state.messages[0].attachments[0].objectKey = `samples/${'b'.repeat(64)}/files/${sha256}`;
  assert.throws(() => validateState(state, owner), { status: 400 });
  state.messages[0].attachments = [];
  await save(fixture.api, state, 1, 'next-write-123456789');
  await assert.rejects(fixture.api({ method: 'POST', path: '/api/files/download', sub: 'owner-sub', body: { objectKey: key } }), { status: 404 });
});
test('authenticated mail writes require same origin, CSRF, body hash; unauthenticated API is denied', async () => {
  const value = 'x'.repeat(43), api = setup().api;
  const records = new Map([['owner', { sub: 'owner-sub', email: 'owner@example.net' }], [`session#${hash(value)}`, { sub: 'owner-sub', csrf: 'csrf', expiresAt: 9999999999 }]]);
  const handler = createStageHandler({ origin: 'https://stage.invalid', ownerEmail: 'owner@example.net', store: { get: async key => records.get(key) }, api });
  const body = JSON.stringify({ revision: 0, writeId: '12345678-1234-1234-1234-123456789abc', state: seedState() });
  const event = { rawPath: '/api/state', requestContext: { http: { method: 'PUT' } }, cookies: [`${sessionCookie}=${value}`], body, headers: { origin: 'https://stage.invalid', 'x-inbox-csrf': 'csrf', 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') } };
  assert.equal((await handler({ ...event, cookies: [] })).statusCode, 401);
  assert.equal((await handler({ ...event, headers: { ...event.headers, origin: 'https://evil.invalid' } })).statusCode, 403);
  assert.equal((await handler({ ...event, headers: { ...event.headers, 'x-inbox-csrf': 'wrong' } })).statusCode, 403);
  assert.equal((await handler({ ...event, headers: { ...event.headers, 'x-amz-content-sha256': 'wrong' } })).statusCode, 400);
  assert.equal((await handler(event)).statusCode, 200);
});

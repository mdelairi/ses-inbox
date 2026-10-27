import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageHandler, hash, loginCookie, sessionCookie } from '../stage/auth.mjs';

const origin = 'https://desk-stage.example.net', email = 'owner@example.net';
function harness() {
  const records = new Map(); let time = 1_800_000_000, claims = {}, exchanges = 0;
  const store = {
    async get(pk) { return structuredClone(records.get(pk)); },
    async put(record) { records.set(record.pk, structuredClone(record)); },
    async remove(pk) { records.delete(pk); },
    async takeLogin(pk, binding, now) { const item = records.get(pk); if (!item || item.binding !== binding || item.expiresAt <= now) return null; records.delete(pk); return item; },
    async pinOwner(record) { if (!records.has('owner')) records.set('owner', record); return records.get('owner'); },
  };
  const handler = createStageHandler({ origin, ownerEmail: email, store, now: () => time,
    getGoogleClient: async () => ({ clientId: 'client', clientSecret: 'secret' }),
    exchangeCode: async () => { exchanges++; return 'signed-id-token'; },
    verifyGoogleToken: async () => claims,
    asset: async path => path === '/' || path === '/app.mjs' ? { type: 'text/plain', body: 'protected asset' } : null,
  });
  const request = (path, cookie = [], options = {}) => handler({ rawPath: path, cookies: cookie, requestContext: { http: { method: 'GET' } }, headers: {}, ...options });
  async function login(nextClaims = {}) {
    const start = await request('/auth/login'); const url = new URL(start.headers.location);
    const state = url.searchParams.get('state'), entry = records.get(`login#${hash(state)}`);
    claims = { email, email_verified: true, sub: 'google-owner-1', nonce: entry.nonce, ...nextClaims };
    const binding = start.cookies[0].split(';')[0];
    const callback = () => request('/auth/callback', [binding], { rawQueryString: new URLSearchParams({ state, code: 'authorization-code' }).toString() });
    return { callback, binding, entry, start, url };
  }
  return { request, login, records, advance: seconds => { time += seconds; }, exchanges: () => exchanges };
}
test('all application assets and session metadata require a valid owner session', async () => {
  const app = harness();
  assert.equal((await app.request('/')).headers.location, '/signin');
  for (const path of ['/app.mjs', '/fixtures.mjs', '/auth/session', '/api/send']) assert.equal((await app.request(path)).statusCode, 401);
  assert.equal((await app.request('/app.mjs', [], { requestContext: { http: { method: 'HEAD' } } })).statusCode, 401);
  const page = await app.request('/signin'); assert.equal(page.statusCode, 200); assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
});
test('login uses state, nonce, S256 PKCE and a secure browser-binding cookie', async () => {
  const app = harness(), { start, url, entry } = await app.login();
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(entry.verifier.length, 43); assert.equal(entry.nonce.length, 43);
  assert.match(start.cookies[0], new RegExp(`^${loginCookie}=`)); assert.match(start.cookies[0], /Secure; HttpOnly; SameSite=Lax/);
});
test('callback is bound to its browser, expires explicitly, and cannot be replayed', async () => {
  const app = harness(), { callback, binding, url } = await app.login();
  const query = new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }).toString();
  assert.equal((await app.request('/auth/callback', [], { rawQueryString: query })).statusCode, 400);
  assert.equal((await callback()).statusCode, 303); assert.equal((await callback()).statusCode, 403); assert.equal(app.exchanges(), 1);
  const another = await app.login(); app.advance(601); assert.equal((await another.callback()).statusCode, 403);
  assert.ok(binding);
});
test('another Google account, an unverified email, and a wrong nonce cannot enroll', async () => {
  for (const claims of [{ email: 'someone-else@example.net' }, { email_verified: false }, { nonce: 'wrong' }]) {
    const app = harness(), { callback } = await app.login(claims);
    assert.equal((await callback()).statusCode, 403); assert.equal(app.records.has('owner'), false);
  }
});
test('first allowed login pins the stable Google subject; later subject replacement is denied', async () => {
  const app = harness(); assert.equal((await (await app.login()).callback()).statusCode, 303);
  const changed = await app.login({ sub: 'different-google-sub' }); assert.equal((await changed.callback()).statusCode, 403);
  assert.equal(app.records.get('owner').sub, 'google-owner-1');
});
test('opaque cookies contain no Google tokens, and explicit expiry blocks uncleared TTL records', async () => {
  const app = harness(), result = await (await app.login()).callback();
  const value = result.cookies.find(value => value.startsWith(sessionCookie)).split(';')[0];
  assert.doesNotMatch(value, /google-owner|signed-id|secret/); assert.equal((await app.request('/app.mjs', [value])).statusCode, 200);
  assert.equal((await app.request('/api/send', [value])).statusCode, 404);
  app.advance(86_401); assert.equal((await app.request('/app.mjs', [value])).statusCode, 401);
});
test('logout requires same origin and CSRF, revokes the server session immediately', async () => {
  const app = harness(), result = await (await app.login()).callback(), value = result.cookies[0].split(';')[0];
  const active = JSON.parse((await app.request('/auth/session', [value])).body);
  const post = headers => app.request('/auth/logout', [value], { requestContext: { http: { method: 'POST' } }, headers });
  assert.equal((await post({ origin: 'https://attacker.example', 'x-inbox-csrf': active.csrf })).statusCode, 403);
  assert.equal((await post({ origin, 'x-inbox-csrf': 'wrong' })).statusCode, 403);
  assert.equal((await post({ origin, 'x-inbox-csrf': active.csrf })).statusCode, 200);
  assert.equal((await app.request('/app.mjs', [value])).statusCode, 401);
});
test('disabling the pinned owner invalidates an otherwise live session', async () => {
  const app = harness(), result = await (await app.login()).callback();
  app.records.get('owner').disabled = true;
  assert.equal((await app.request('/app.mjs', [result.cookies[0].split(';')[0]])).statusCode, 401);
});

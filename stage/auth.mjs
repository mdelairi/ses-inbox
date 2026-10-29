import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_SECONDS = 86_400;
export const LOGIN_SECONDS = 600;
export const sessionCookie = '__Host-inbox-session';
export const loginCookie = '__Host-inbox-login';
export const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const headers = {
  'cache-control': 'private, no-store, max-age=0',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
// Fetched by the browser itself (Home Screen install, service-worker updates), possibly without
// the session cookie. They hold no mail or account data.
export const PUBLIC_ASSETS = new Set(['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);
class Rejection extends Error {
  constructor(status) { super('Request rejected'); this.status = status; }
}
function requireThat(condition, status = 400) { if (!condition) throw new Rejection(status); }
function cookies(event) {
  const parts = (event.cookies || [event.headers?.cookie || '']).join(';').split(';').map(part => part.trim()).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const position = part.indexOf('='), name = part.slice(0, position);
    requireThat(position > 0 && !Object.hasOwn(result, name));
    result[name] = part.slice(position + 1);
  }
  return result;
}
function response(statusCode, body = '', type = 'text/html; charset=utf-8', extra = {}) {
  return { statusCode, headers: { ...headers, 'content-type': type, ...extra }, body };
}
const redirect = (location, cookieValues = []) => ({ ...response(303, '', undefined, { location }), cookies: cookieValues });
const json = (status, body) => response(status, JSON.stringify(body), 'application/json');
function loginPage(shared = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Inbox · Stage</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f3f5f4;font:15px system-ui;color:#33383c}main{max-width:390px;padding:40px;margin:20px;background:white;border:1px solid #dce4df;border-radius:16px}small{color:#697177;letter-spacing:1px}h1{font-size:28px}p{line-height:1.7;color:#697177}a{display:block;background:#426859;color:white;text-align:center;text-decoration:none;padding:13px;border-radius:8px;margin-top:25px}</style></head><body><main><small>PRIVATE STAGING PREVIEW</small><h1>Your project mail.</h1><p>Sign in with your owner Google account to test the interface with sample mail. Sending is simulated; ${shared ? 'mail and drafts are shared across your signed-in devices' : 'changes stay in this browser'}.</p><a href="/auth/login">Continue with Google</a></main></body></html>`;
}

// AWS and Google's verifier are injected so security behavior can be tested offline.
export function createStageHandler({ origin, ownerEmail, store, getGoogleClient, exchangeCode, verifyGoogleToken, asset, api, storageOrigin, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || !ownerEmail) throw new Error('Invalid staging configuration');
  if (storageOrigin && !/^https:\/\/[a-z0-9.-]+\.s3\.us-east-1\.amazonaws\.com$/.test(storageOrigin)) throw new Error('Invalid storage origin');
  const callback = `${origin}/auth/callback`;
  async function session(event) {
    const value = cookies(event)[sessionCookie];
    if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) return null;
    const record = await store.get(`session#${hash(value)}`);
    if (!record || record.expiresAt <= now()) return null;
    const owner = await store.get('owner');
    if (!owner || owner.disabled || record.sub !== owner.sub || owner.email !== ownerEmail) return null;
    return record;
  }
  return async event => {
    const method = event.requestContext?.http?.method || '', path = event.rawPath || '';
    try {
      requireThat(path.length < 1024 && !path.includes('\\'));
      if (path === '/auth/logout') {
        requireThat(method === 'POST', 405);
        requireThat(event.headers?.origin === origin, 403);
        const active = await session(event);
        requireThat(active && equal(event.headers?.['x-inbox-csrf'], active.csrf), 403);
        await store.remove(active.pk);
        return { ...json(200, { signedOut: true }), cookies: [cookie(sessionCookie, '', 0), cookie(loginCookie, '', 0)] };
      }
      if (path.startsWith('/api/') && api) {
        const active = await session(event);
        requireThat(active, 401);
        requireThat(['GET', 'PUT', 'POST'].includes(method), 405);
        let body;
        if (method !== 'GET') {
          requireThat(event.headers?.origin === origin && equal(event.headers?.['x-inbox-csrf'], active.csrf), 403);
          const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
          requireThat(Buffer.byteLength(raw) <= 2 * 1024 * 1024 + 4096, 413);
          requireThat(equal(event.headers?.['x-amz-content-sha256'], hash(raw)), 400);
          requireThat(event.headers?.['content-type']?.split(';')[0] === 'application/json', 415);
          try { body = JSON.parse(raw); } catch { requireThat(false); }
        }
        const result = await api({ method, path, body, sub: active.sub });
        return json(result.status, result.data);
      }
      requireThat(['GET', 'HEAD'].includes(method), 405);
      if (path === '/signin') return response(200, method === 'HEAD' ? '' : loginPage(Boolean(api)));
      if (path === '/auth/login') {
        requireThat(method === 'GET', 405);
        const state = token(), binding = token(), verifier = token(), nonce = token();
        const client = await getGoogleClient();
        await store.put({ pk: `login#${hash(state)}`, binding: hash(binding), verifier, nonce, expiresAt: now() + LOGIN_SECONDS });
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        return redirect(url.href, [cookie(loginCookie, binding, LOGIN_SECONDS)]);
      }
      if (path === '/auth/callback') {
        requireThat(method === 'GET', 405);
        const query = new URLSearchParams(event.rawQueryString || '');
        const state = query.get('state'), code = query.get('code'), binding = cookies(event)[loginCookie];
        requireThat(query.getAll('state').length === 1 && query.getAll('code').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state || '') && /^[A-Za-z0-9_-]{43}$/.test(binding || '') && code && code.length < 4096);
        // Consume once, atomically, only when browser binding and expiry both match.
        const transaction = await store.takeLogin(`login#${hash(state)}`, hash(binding), now());
        requireThat(transaction, 403);
        const client = await getGoogleClient();
        const idToken = await exchangeCode({ code, verifier: transaction.verifier, callback, ...client });
        const claims = await verifyGoogleToken(idToken, client.clientId);
        requireThat(claims.email === ownerEmail && claims.email_verified === true && equal(claims.nonce, transaction.nonce) && typeof claims.sub === 'string' && claims.sub.length > 0, 403);
        const owner = await store.pinOwner({ pk: 'owner', sub: claims.sub, email: ownerEmail });
        requireThat(owner.sub === claims.sub && owner.email === ownerEmail && !owner.disabled, 403);
        const value = token(), active = { pk: `session#${hash(value)}`, sub: owner.sub, csrf: token(), expiresAt: now() + SESSION_SECONDS };
        await store.put(active);
        // Google access/refresh/ID tokens never go into the browser or session table.
        return redirect('/', [cookie(sessionCookie, value, SESSION_SECONDS), cookie(loginCookie, '', 0)]);
      }
      if (PUBLIC_ASSETS.has(path)) {
        const file = await asset(path);
        if (!file) return response(404, 'Not found', 'text/plain');
        const result = response(200, method === 'HEAD' ? '' : file.body, file.type);
        if (file.base64 && method !== 'HEAD') result.isBase64Encoded = true;
        return result;
      }
      const active = await session(event);
      if (!active) return path === '/' ? redirect('/signin') : json(401, { error: 'Sign in required' });
      if (path === '/auth/session') return json(200, { email: ownerEmail, csrf: active.csrf, expiresAt: active.expiresAt });
      if (path.startsWith('/api/')) return json(404, { error: 'This staging preview has no live mail API' });
      const file = await asset(path);
      if (!file) return response(404, 'Not found', 'text/plain');
      const result = response(200, method === 'HEAD' ? '' : file.body, file.type);
      if (storageOrigin) result.headers['content-security-policy'] = headers['content-security-policy'].replace("connect-src 'self'", `connect-src 'self' ${storageOrigin}`);
      if (file.base64 && method !== 'HEAD') result.isBase64Encoded = true;
      return result;
    } catch (error) {
      if (!error.status) log({ name: error.name || 'Error', requestId: event.requestContext?.requestId });
      return json(error.status || 503, { error: error.name === 'MailError' ? error.message : error.status === 403 ? 'Access denied' : error.status ? 'Request rejected' : 'The service is temporarily unavailable' });
    }
  };
}

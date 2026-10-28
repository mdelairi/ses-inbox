import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createStageHandler, hash, sessionCookie } from '../../stage/auth.mjs';
import { createMailApi } from '../../stage/mail-api.mjs';
const { test, expect } = await import(process.env.INBOX_PLAYWRIGHT_MODULE || '@playwright/test');
const origin = 'https://stage-preview.invalid';
const types = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
const storageOrigin = 'https://inbox-sample-test.s3.us-east-1.amazonaws.com';
function sharedBackend() {
  const heads = new Map(), objects = new Map();
  const api = createMailApi({ heads: { tombstones: async () => [], retired: async () => [], get: async key => heads.get(key), compareAndSwap: async (key, revision, next) => { if ((heads.get(key)?.revision || 0) !== revision) return false; heads.set(key, next); return true; } }, objects: {
    read: async key => objects.get(key).body.toString(), write: async (key, value) => objects.set(key, { body: Buffer.from(value) }), remove: async key => objects.delete(key),
    downloadUrl: async key => `${storageOrigin}/${key}`, head: async key => ({ size: objects.get(key)?.body.length, sha256: objects.get(key)?.sha256 }),
    uploadUrl: async (key, sha256) => ({ url: `${storageOrigin}/${key}`, headers: { 'content-type': 'application/octet-stream', 'x-inbox-sha256': sha256 } }),
  } });
  return { api, objects, heads };
}
async function stage(context, page, signedIn = true, backend = sharedBackend()) {
  const value = randomBytes(32).toString('base64url');
  const records = new Map([
    ['owner', { sub: 'owner-google-id', email: 'owner@example.net' }],
    [`session#${hash(value)}`, { pk: `session#${hash(value)}`, sub: 'owner-google-id', csrf: 'session-csrf', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
  ]);
  const assets = JSON.parse(await readFile(new URL('../../build/stage/assets-manifest.json', import.meta.url)));
  const handler = createStageHandler({ origin, ownerEmail: 'owner@example.net', store: { get: async pk => records.get(pk), remove: async pk => records.delete(pk) },
    api: backend.api, storageOrigin,
    asset: async path => {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!Object.hasOwn(assets, name)) return null;
      return { type: types[name.split('.').at(-1)] || 'application/octet-stream', body: (await readFile(new URL(`../../build/stage/assets/${name}`, import.meta.url))).toString('base64'), base64: true };
    },
  });
  await page.route(`${storageOrigin}/**`, async route => {
    const request = route.request(), key = new URL(request.url()).pathname.slice(1), headers = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,PUT,HEAD,OPTIONS', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers });
    if (request.method() === 'PUT') { backend.objects.set(key, { body: request.postDataBuffer(), sha256: (await request.allHeaders())['x-inbox-sha256'] }); return route.fulfill({ status: 200, headers }); }
    const value = backend.objects.get(key); return route.fulfill({ status: value ? 200 : 404, headers, body: value?.body || '' });
  });
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), requestHeaders = await request.allHeaders();
    const result = await handler({ rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: requestHeaders, body: request.postData(), requestContext: { http: { method: request.method() } } });
    const headers = { ...result.headers };
    if (result.cookies?.length) headers['set-cookie'] = result.cookies[0];
    await route.fulfill({ status: result.statusCode, headers, body: result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body });
  });
  if (signedIn) await context.addCookies([{ name: sessionCookie, value, domain: 'stage-preview.invalid', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  // Playwright's synthetic route fulfills only the first request in a redirect
  // chain. Root -> /signin redirects are covered by the handler unit tests.
  await page.goto(signedIn ? origin : `${origin}/signin`);
  return backend;
}
test('protected staging assets render under the real CSP with separate alias tabs and rich mail', async ({ context, page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await stage(context, page);
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.locator('.preview-label')).toHaveText('Staging · sample mail');
  await page.getByRole('button', { name: /Switch domain:/ }).click(); await page.getByRole('button', { name: 'example.org', exact: true }).click();
  await page.getByRole('tab', { name: 'Open mailbox support@example.org', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.locator('#compose-from')).toHaveValue('t-support'); await expect(page.locator('#compose-from')).toBeDisabled();
  await page.getByRole('button', { name: 'Save and close draft' }).click();
  await page.getByRole('tab', { name: 'Open mailbox no-reply@example.org', exact: true }).click();
  await page.getByRole('button', { name: 'Open A little reminder: your course is ready', exact: true }).click();
  await expect(page.frameLocator('.message-frame').getByRole('heading', { name: 'A little learning, a big step forward.' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('staging phone layout fits and sign-out revokes access to application assets', async ({ context, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stage(context, page);
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/signin`);
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/app.mjs')).status);
  expect(status).toBe(401);
});
test('signed-out staging cannot read the application or sample fixture modules', async ({ context, page }) => {
  await stage(context, page, false);
  await expect(page).toHaveURL(`${origin}/signin`);
  const statuses = await page.evaluate(async () => Promise.all(['/app.mjs', '/fixtures.mjs', '/auth/session'].map(async path => (await fetch(path)).status)));
  expect(statuses).toEqual([401, 401, 401]);
});

test('drafts, attachments and alias settings persist across independent browsers; stale saves keep recovery', async ({ browser, context, page }) => {
  test.setTimeout(60000);
  const backend = await stage(context, page);
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.locator('#compose-to').fill('recipient@example.net');
  await page.locator('#compose-subject').fill('Cross-device draft');
  await page.locator('#message-editor').fill('Retain this text on another device.');
  await page.locator('#attachment-input').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment from browser one') });
  await page.locator('#inline-input').setInputFiles({ name: 'inline.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Save and close draft' }).click();
  await page.getByRole('button', { name: 'Aliases & settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add address', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('hello@example.com');
  await page.getByLabel('Sender display name', { exact: true }).fill('Shared hello');
  await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const other = await browser.newContext(), second = await other.newPage();
  await stage(other, second, true, backend);
  await second.getByRole('button', { name: 'Aliases & settings', exact: true }).click();
  await expect(second.locator('.alias-card').filter({ hasText: 'hello@example.com' })).toContainText('Shared hello');
  await second.getByRole('button', { name: 'Close settings', exact: true }).click();
  await second.getByRole('button', { name: /^Drafts/ }).click();
  await second.getByRole('button', { name: 'Resume draft: Cross-device draft' }).click();
  await expect(second.locator('#message-editor')).toContainText('Retain this text on another device.');
  await expect(second.locator('#compose-attachments')).toContainText('draft.txt');
  await expect(second.locator('#message-editor img[data-file-id]')).toHaveAttribute('src', /^data:image\/png/);
  await second.locator('#compose-subject').fill('Updated on device two');
  await second.getByRole('button', { name: 'Save and close draft' }).click();
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.getByRole('button', { name: 'Resume draft: Cross-device draft' }).click();
  await page.locator('#compose-subject').fill('Conflicting unsaved draft');
  await page.getByRole('button', { name: 'Save and close draft' }).click();
  await expect(page.locator('#storage-notice')).toContainText(/another device|saved first/i);
  await expect(page.getByRole('button', { name: 'Download unsaved copy' })).toBeVisible();
  await expect(page.locator('#compose-dialog')).toBeVisible();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download unsaved copy' }).click();
  expect((await downloaded).suggestedFilename()).toBe('inbox-unsaved-copy.json');
  await second.reload(); await second.getByRole('button', { name: /^Drafts/ }).click();
  await expect(second.getByRole('button', { name: 'Resume draft: Updated on device two' })).toBeVisible();
  await other.close();
});

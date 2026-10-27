import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createStageHandler, hash, sessionCookie } from '../../stage/auth.mjs';
const { test, expect } = await import(process.env.INBOX_PLAYWRIGHT_MODULE || '@playwright/test');
const origin = 'https://stage-preview.invalid';
const types = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
async function stage(context, page, signedIn = true) {
  const value = randomBytes(32).toString('base64url');
  const records = new Map([
    ['owner', { sub: 'owner-google-id', email: 'owner@example.net' }],
    [`session#${hash(value)}`, { pk: `session#${hash(value)}`, sub: 'owner-google-id', csrf: 'session-csrf', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
  ]);
  const assets = JSON.parse(await readFile(new URL('../../build/stage/assets-manifest.json', import.meta.url)));
  const handler = createStageHandler({ origin, ownerEmail: 'owner@example.net', store: { get: async pk => records.get(pk), remove: async pk => records.delete(pk) },
    asset: async path => {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!Object.hasOwn(assets, name)) return null;
      return { type: types[name.split('.').at(-1)] || 'application/octet-stream', body: (await readFile(new URL(`../../build/stage/assets/${name}`, import.meta.url))).toString('base64'), base64: true };
    },
  });
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), requestHeaders = await request.allHeaders();
    const result = await handler({ rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: requestHeaders, requestContext: { http: { method: request.method() } } });
    const headers = { ...result.headers };
    if (result.cookies?.length) headers['set-cookie'] = result.cookies[0];
    await route.fulfill({ status: result.statusCode, headers, body: result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body });
  });
  if (signedIn) await context.addCookies([{ name: sessionCookie, value, domain: 'stage-preview.invalid', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  // Playwright's synthetic route fulfills only the first request in a redirect
  // chain. Root -> /signin redirects are covered by the handler unit tests.
  await page.goto(signedIn ? origin : `${origin}/signin`);
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

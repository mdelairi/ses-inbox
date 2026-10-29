// Live-mail UI against the real mail API, gateway and a local PostgreSQL. S3 is an
// in-memory store behind a routed origin; SES is a recorder. Nothing leaves this machine.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createStageHandler, hash, sessionCookie } from '../../stage/auth.mjs';
import { createMailApi } from '../../mail/api.mjs';
import { createPush } from '../../mail/push.mjs';
import { createCapturedSender } from '../../capture/producer.mjs';
import { createCaptureImporter } from '../../mail/capture-import.mjs';
import { versionedObjects } from '../helpers/versioned-mail-objects.mjs';
import { parseMessage } from '../../mail/parse.mjs';
import { postgresAvailable, startPostgres } from '../helpers/postgres.mjs';
import { bucket, mailFixture } from '../helpers/mail-fixture.mjs';
const { test, expect } = await import(process.env.INBOX_PLAYWRIGHT_MODULE || '@playwright/test');
const origin = 'https://inbox-live.invalid', storageOrigin = 'https://inbox-mail-test.s3.us-east-1.amazonaws.com';
const types = { html: 'text/html', mjs: 'text/javascript', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.describe.configure({ mode: 'serial' });
test.skip(!postgresAvailable, 'local PostgreSQL is not installed');
let db;
test.beforeAll(async () => { execFileSync(process.execPath, [new URL('../../scripts/prepare-live.mjs', import.meta.url).pathname.replaceAll('%20', ' ')]); db = await startPostgres(); });
test.afterAll(async () => { await db?.stop(); });

async function live(context, page, seed = async () => {}) {
  const f = await mailFixture(db), sent = [], pushed = [];
  await seed(f);
  const objects = { ...f.objects, downloadUrl: async key => `${storageOrigin}/${key}`,
    uploadUrl: async (key, sha256) => ({ url: `${storageOrigin}/${key}`, headers: { 'content-type': 'application/octet-stream', 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') } }) };
  const ses = { async sendRaw(request) { sent.push(request); return { messageId: `ses-${sent.length}` }; } };
  const push = createPush({ pool: db.pool, vapid: async () => ({ publicKey: 'BPublicKeyForTests', privateKey: 'private', subject: 'mailto:owner@example.net' }), send: async (target, payload) => { pushed.push(JSON.parse(payload)); } });
  const api = createMailApi({ pool: db.pool, objects, ses, bucket, configurationSet: 'inbox', push });
  const value = randomBytes(32).toString('base64url');
  const records = new Map([['owner', { sub: 'owner-google-id', email: 'owner@example.net' }],
    [`session#${hash(value)}`, { pk: `session#${hash(value)}`, sub: 'owner-google-id', csrf: 'session-csrf', expiresAt: Math.floor(Date.now() / 1000) + 3600 }]]);
  const assets = JSON.parse(await readFile(new URL('../../build/live/assets-manifest.json', import.meta.url)));
  const handler = createStageHandler({ origin, ownerEmail: 'owner@example.net', store: { get: async pk => records.get(pk), remove: async pk => records.delete(pk) }, api, storageOrigin,
    asset: async path => {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!Object.hasOwn(assets, name)) return null;
      return { type: types[name.split('.').at(-1)] || 'application/octet-stream', body: (await readFile(new URL(`../../build/live/assets/${name}`, import.meta.url))).toString('base64'), base64: true };
    } });
  await page.route(`${storageOrigin}/**`, async route => {
    const request = route.request(), key = decodeURIComponent(new URL(request.url()).pathname.slice(1)), headers = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,PUT,OPTIONS', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers });
    if (request.method() === 'PUT') { await f.objects.put(key, request.postDataBuffer()); return route.fulfill({ status: 200, headers }); }
    return route.fulfill({ status: f.stored.has(key) ? 200 : 404, headers, body: f.stored.get(key) || '' });
  });
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const result = await handler({ rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: await request.allHeaders(), body: request.postData(), requestContext: { http: { method: request.method() } } });
    await route.fulfill({ status: result.statusCode, headers: result.headers, body: result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body });
  });
  await context.addCookies([{ name: sessionCookie, value, domain: 'inbox-live.invalid', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(origin);
  return { ...f, sent, pushed, push };
}

test('real mail: read with inline images, reply, archive, and server search', async ({ context, page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const t = await live(context, page, f => f.deliver(['info@example.com'], { subject: 'Workshop dates', messageId: '<workshop@example.net>', text: 'Can we meet about invoices?',
    html: '<p>Can we meet about <b>invoices</b>?</p><img src="cid:logo@x" alt="Logo">', attachments: [{ filename: 'brief.pdf', content: Buffer.from('%PDF-1'), contentType: 'application/pdf' }, { filename: 'logo.png', content: PNG, cid: 'logo@x', contentType: 'image/png' }] }));
  await expect(page.locator('.profile small')).toHaveText('Live mail');
  await page.getByRole('button', { name: 'Open Workshop dates', exact: true }).click();
  const frame = page.frameLocator('.message-frame');
  await expect(frame.locator('b')).toHaveText('invoices');
  await expect(frame.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.getByRole('button', { name: /brief\.pdf/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /logo\.png/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.locator('#message-editor').click(); await page.keyboard.type('Thursday works for me.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Sent.' })).toBeVisible();
  expect(t.sent).toHaveLength(1);
  const reply = await parseMessage(t.sent[0].raw);
  expect(reply.inReplyTo).toBe('<workshop@example.net>'); expect(reply.text).toContain('Thursday works for me.'); expect(t.sent[0].destination.ToAddresses).toEqual(['avery@example.net']);

  await page.getByRole('button', { name: 'Sent', exact: true }).click();
  await page.getByRole('button', { name: 'Open Re: Workshop dates', exact: true }).click();
  // Folder labels are stable regardless of the relative fixture and system clocks.
  await expect(page.locator('.reader-labels').getByText('Sent', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Open Workshop dates', exact: true }).click();
  await page.getByRole('button', { name: 'Archive conversation' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Moved to Archive.' })).toBeVisible();
  await expect.poll(async () => (await db.pool.query("SELECT folder FROM mail.mailbox_entries e JOIN mail.messages m USING (domain_id, message_id) WHERE m.subject='Workshop dates'")).rows.map(row => row.folder)).toEqual(['archive']);

  await page.locator('#mail-search').fill('invoices');
  // Search groups the original and reply; its row title follows the newest message.
  await expect(page.getByRole('button', { name: /^Open (Re: )?Workshop dates$/ })).toBeVisible();
  await page.locator('#mail-search').fill('nothingmatches');
  await expect(page.getByText('No matching conversations')).toBeVisible();
  expect(errors).toEqual([]);
});

test('real mail: drafts save to the server and survive a reload; sample tools are disabled', async ({ context, page }) => {
  await live(context, page);
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await page.locator('#compose-to').fill('client@example.net');
  await page.locator('#compose-subject').fill('Proposal draft');
  await page.getByRole('button', { name: 'Save and close draft' }).click();
  await expect.poll(async () => (await db.pool.query('SELECT subject FROM mail.drafts')).rows.map(row => row.subject)).toEqual(['Proposal draft']);
  await page.reload();
  await page.getByRole('button', { name: /^Drafts/ }).click(); // Its name includes the draft count.
  await expect(page.getByRole('button', { name: 'Resume draft: Proposal draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Aliases & settings' }).click();
  await expect(page.getByRole('button', { name: 'Add address' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Local preview' })).toHaveCount(0);
});

test('real mail: forwarding rules are set per receiving address', async ({ context, page }) => {
  await live(context, page);
  await page.getByRole('button', { name: 'Aliases & settings' }).click();
  const card = page.locator('.alias-card').filter({ hasText: 'info@example.com' });
  await expect(card.locator('.forward-summary')).toHaveText('Forwarding: off');
  await card.getByRole('button', { name: 'Set up forwarding' }).click();
  await page.locator('#forward-form textarea').fill('taylor@example.com');
  await page.getByRole('button', { name: 'Save forwarding' }).click();
  await expect(page.locator('#forward-error')).toHaveText('Forward to an address outside this inbox.');
  await page.locator('#forward-form textarea').fill('Me@Gmail.com\nteam@example.net');
  await page.getByRole('button', { name: 'Save forwarding' }).click();
  await expect(card.locator('.forward-summary')).toHaveText('Forwards new mail to me@gmail.com, team@example.net');
  expect((await db.pool.query('SELECT target FROM mail.forward_rules ORDER BY target')).rows.map(row => row.target)).toEqual(['me@gmail.com', 'team@example.net']);
  await card.getByRole('button', { name: 'Change forwarding' }).click();
  await page.locator('#forward-form textarea').fill('');
  await page.getByRole('button', { name: 'Save forwarding' }).click();
  await expect(card.locator('.forward-summary')).toHaveText('Forwarding: off');
  await expect(card.getByRole('button', { name: 'Set up forwarding' })).toBeVisible();
});

test('real mail: notification settings list devices and send a test', async ({ context, page }) => {
  const t = await live(context, page);
  await t.push.subscribe({ subscription: { endpoint: 'https://web.push.apple.com/device-1', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, label: 'iPhone · Home Screen app' });
  await page.getByRole('button', { name: 'Notifications', exact: true }).first().click();
  await expect(page.locator('.settings-panel')).toContainText('iPhone · Home Screen app');
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test notification' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Test sent to 1 device.' })).toBeVisible();
  expect(t.pushed).toEqual([{ title: 'Inbox', body: 'Notifications are working on this device.', tag: 'inbox-test', url: '/' }]);
  await page.locator('.settings-panel').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.settings-panel')).toContainText('No devices yet.');
});

test('real mail: select several conversations to mark, move and forward them together', async ({ context, page }) => {
  const t = await live(context, page, async f => {
    await f.deliver(['info@example.com'], { subject: 'First request', text: 'Body of the first request' });
    await f.deliver(['info@example.com'], { subject: 'Second request', text: 'Body of the second request', attachments: [{ filename: 'plan.txt', content: 'the plan' }] });
    await f.deliver(['info@example.com'], { subject: 'Third request', text: 'Body of the third request' });
  });
  const rowsIn = folder => db.pool.query("SELECT m.subject, e.folder, e.is_read FROM mail.mailbox_entries e JOIN mail.messages m USING (domain_id, message_id) ORDER BY m.subject").then(result => result.rows.filter(row => !folder || row.folder === folder));
  await page.getByRole('checkbox', { name: 'Select First request' }).check();
  await page.getByRole('checkbox', { name: 'Select Third request' }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.bulk-count')).toHaveText('3 selected');
  await page.getByRole('checkbox', { name: 'Select Second request' }).uncheck();
  await expect(page.locator('.bulk-count')).toHaveText('2 selected');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect.poll(async () => (await rowsIn()).map(row => [row.subject, row.is_read])).toEqual([['First request', true], ['Second request', false], ['Third request', true]]);
  await page.locator('#check-all').check();
  await expect(page.locator('.bulk-count')).toHaveText('3 selected');
  await page.locator('#check-all').uncheck();
  await expect(page.locator('.bulk-bar')).toHaveCount(0);

  await page.getByRole('checkbox', { name: 'Select Second request' }).check();
  await page.getByRole('checkbox', { name: 'Select Third request' }).check();
  await page.getByRole('button', { name: 'Forward selected' }).click();
  await expect(page.locator('#compose-subject')).toHaveValue('Fwd: 2 conversations', { timeout: 15000 }); // both conversations load first
  await expect(page.locator('#compose-attachments')).toContainText('plan.txt');
  await page.locator('#compose-to').fill('partner@example.net');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Sent.' })).toBeVisible();
  const forwarded = await parseMessage(t.sent[0].raw);
  expect(forwarded.text).toContain('Body of the second request'); expect(forwarded.text).toContain('Body of the third request'); expect(forwarded.text).not.toContain('first request');
  expect(forwarded.attachments.map(item => item.filename)).toEqual(['plan.txt']);

  await page.getByRole('checkbox', { name: 'Select First request' }).check();
  await page.getByRole('checkbox', { name: 'Select Second request' }).check();
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Moved 2 conversations to Trash.' })).toBeVisible();
  await expect.poll(async () => (await rowsIn('trash')).map(row => row.subject)).toEqual(['First request', 'Second request']);
  await page.getByRole('button', { name: /^Trash/ }).click();
  await page.locator('#check-all').check();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect.poll(async () => (await rowsIn()).map(row => row.subject)).toEqual(['Fwd: 2 conversations', 'Third request']);
});

test('automated capture uses a read-only sender mailbox and shows staging/source labels', async ({ context, page }) => {
  await live(context, page, async f => {
    const captureObjects = versionedObjects(), source = 'exampleorg-staging', id = 'e5d7ab9f-78bc-4ac7-9e0c-35807fe0ec10';
    const send = createCapturedSender({ source, put: (key, value) => captureObjects.put(key, JSON.stringify(value)), send: async () => ({ MessageId: 'captured-provider' }) });
    await send({ id, kind: 'course_assigned', input: { FromEmailAddress: 'ExampleOrg <no-reply@example.org>', Destination: { ToAddresses: ['learner@example.invalid'] }, Content: { Simple: { Subject: { Data: 'Your assigned workshop' }, Body: { Text: { Data: 'A workshop was assigned to you.' } } } } } });
    await createCaptureImporter({ pool: db.pool, objects: f.objects, captureObjects, bucket }).ingest(source, id);
  });
  await page.getByRole('button', { name: 'Switch domain: example.com' }).click();
  await page.getByRole('button', { name: /example.org/ }).click();
  await page.getByRole('tab', { name: 'Open mailbox no-reply@example.org' }).click();
  await expect(page.getByRole('button', { name: 'Compose', exact: true }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Sent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Your assigned workshop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Your assigned workshop', exact: true }).click();
  await expect(page.getByText('Automated', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Staging', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
});

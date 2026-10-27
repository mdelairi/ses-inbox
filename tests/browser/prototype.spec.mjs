const { test, expect } = await import(process.env.INBOX_PLAYWRIGHT_MODULE || '@playwright/test');
const errors = new WeakMap();
test.beforeEach(async ({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page).push(error.message)); await page.goto('/'); await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible(); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
async function switchDomain(page, domain) { await page.getByRole('button', { name: /Switch domain:/ }).click(); await page.getByRole('button', { name: domain, exact: true }).click(); }
async function mailbox(page, address) { await page.getByRole('tab', { name: `Open mailbox ${address}`, exact: true }).click(); }
async function folder(page, name) { await page.getByRole('navigation', { name: 'Mail folders' }).getByRole('button', { name: new RegExp(`^${name}`) }).click(); }

test('domain-scoped search and staging filters', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search current mailbox' }).fill('"final schedule"');
  await expect(page.getByRole('button', { name: 'Open The final event schedule', exact: true })).toBeVisible();
  await switchDomain(page, 'example.org');
  await expect(page.getByRole('button', { name: 'Open Could we take a closer look at ExampleOrg?', exact: true })).toBeVisible();
  await mailbox(page, 'no-reply@example.org');
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled();
  await folder(page, 'Sent'); await page.getByRole('button', { name: /Filters/ }).click();
  await page.locator('#filter-source').selectOption('automated'); await page.locator('#filter-environment').selectOption('staging');
  await expect(page.locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.thread-row')).toContainText('[STAGING]');
  await expect(page.locator('.thread-row')).not.toContainText('Example');
});

test('alias-aware reply and drafts survive domain changes and reload', async ({ page }) => {
  await mailbox(page, 'taylor@example.com');
  await page.getByRole('button', { name: 'Open A conversation about the next workshop', exact: true }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('#compose-from')).toHaveValue('d-taylor');
  await expect(page.locator('#compose-to')).toHaveValue('alex@example.net');
  await page.locator('#compose-subject').fill('Draft that must stay with Example');
  await page.getByRole('button', { name: 'Save and close draft' }).click();
  await switchDomain(page, 'example.org'); await folder(page, 'Drafts');
  await expect(page.locator('.draft-row')).toHaveCount(0);
  await switchDomain(page, 'example.com'); await folder(page, 'Drafts');
  await page.getByRole('button', { name: 'Resume draft: Draft that must stay with Example' }).click();
  await expect(page.locator('#compose-from')).toHaveValue('d-taylor');
  await page.getByRole('button', { name: 'Save and close draft' }).click(); await page.reload(); await folder(page, 'Drafts');
  await expect(page.getByRole('button', { name: 'Resume draft: Draft that must stay with Example' })).toBeVisible();
});

test('compose with formatting, inline image, file attachment and local send persists', async ({ page }) => {
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.locator('#compose-to').fill('someone@example.net'); await page.locator('#compose-subject').fill('Prototype flow check');
  const editor = page.getByRole('textbox', { name: 'Message body' }); await editor.fill('A formatted message to remember.');
  await editor.press('ControlOrMeta+a'); await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await editor.press('ArrowRight');
  await page.locator('#attachment-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('An attachment that survives reloading.') });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64');
  await page.locator('#inline-input').setInputFiles({ name: 'inline.png', mimeType: 'image/png', buffer: png });
  await expect(editor.locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Send locally', exact: true }).click();
  await expect(page.locator('#compose-dialog')).not.toBeVisible(); await folder(page, 'Sent');
  await page.getByRole('button', { name: 'Open Prototype flow check', exact: true }).click();
  await expect(page.getByRole('button', { name: /notes.txt/ })).toBeVisible();
  const frame = page.frameLocator('.message-frame'); await expect(frame.locator('strong,b')).toContainText('A formatted message to remember.'); await expect(frame.locator('img')).toHaveCount(1);
  await page.reload(); await folder(page, 'Sent'); await expect(page.getByRole('button', { name: 'Open Prototype flow check', exact: true })).toBeVisible();
});

test('archive undo and permanent deletion stay within the selected domain', async ({ page }) => {
  await mailbox(page, 'taylor@example.com');
  await page.getByRole('button', { name: 'Open A note about your book', exact: true }).click(); await page.getByRole('button', { name: 'Archive conversation' }).click();
  await expect(page.getByRole('button', { name: 'Open A note about your book', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open A note about your book', exact: true })).toBeVisible();
  await mailbox(page, 'info@example.com');
  await folder(page, 'Trash'); await page.getByRole('button', { name: 'Open An earlier version of the agenda', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click(); await page.getByRole('dialog', { name: 'Delete this conversation permanently?' }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open An earlier version of the agenda', exact: true })).not.toBeVisible();
  await page.reload(); await folder(page, 'Trash'); await expect(page.locator('.thread-row')).toHaveCount(0);
  await switchDomain(page, 'example.org'); await expect(page.locator('.thread-row')).toHaveCount(1);
});

test('new aliases persist and disabled aliases cannot be selected for sending', async ({ page }) => {
  await page.getByRole('button', { name: 'Aliases & settings', exact: true }).click(); await page.getByRole('button', { name: 'Add address', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('hello@example.com'); await page.getByLabel('Sender display name', { exact: true }).fill('Example Hello');
  await page.getByLabel('Use as the default sender for this domain').check(); await page.getByRole('button', { name: 'Save address', exact: true }).click();
  const row = page.locator('.alias-card').filter({ hasText: 'hello@example.com' }); await expect(row).toContainText('Default sender'); await row.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.locator('#compose-from')).toBeDisabled();
  await expect(page.locator('#compose-from option')).toHaveCount(1);
  await expect(page.locator('#compose-from')).toHaveValue('d-info'); await page.getByRole('button', { name: 'Save and close draft' }).click();
  await page.reload(); await page.getByRole('button', { name: 'Aliases & settings', exact: true }).click(); await expect(page.locator('.alias-card').filter({ hasText: 'hello@example.com' })).toContainText('Disabled');
});

test('untrusted pasted email HTML cannot execute or fetch remote images', async ({ page }) => {
  const requests = []; page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4317') && !request.url().startsWith('data:')) requests.push(request.url()); });
  const result = await page.evaluate(async () => {
    const { sanitizeHTML, messageDocument } = await import('/safety.mjs');
    const hostile = '<script>window.parent.inboxPwned=1</script><img src="https://tracker.invalid/pixel" onerror="window.parent.inboxPwned=1"><a href="javascript:alert(1)">bad link</a><svg onload="window.parent.inboxPwned=1"></svg><p style="background-image:url(https://tracker.invalid/css)">Safe text</p>';
    const clean = sanitizeHTML(hostile); const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.srcdoc = messageDocument(hostile); document.body.append(frame);
    return { clean, pwned: window.inboxPwned || null };
  });
  expect(result.pwned).toBeNull(); expect(result.clean).not.toMatch(/script|onerror|javascript:|tracker\.invalid|svg|background-image/); expect(result.clean).toContain('Safe text');
  await expect.poll(() => requests).toEqual([]);
});

test('phone navigation, compose and settings fit the viewport', async ({ page }) => {
  await mailbox(page, 'taylor@example.com');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open A conversation about the next workshop', exact: true }).click(); await expect(page.getByRole('heading', { name: 'A conversation about the next workshop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to message list' }).click(); await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Compose', exact: true }).click(); await expect(page.locator('#compose-dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save and close draft' }).click(); await page.getByRole('button', { name: 'Aliases & settings', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await expect(page.locator('.notification-card')).toContainText('Alex Morgan');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('info and support have separate inboxes, drafts, search, sent and fixed senders', async ({ page }) => {
  await switchDomain(page, 'example.org');
  const exampleorgColour = await page.locator('.compose-button').evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(page.locator('.message-list').getByRole('tablist', { name: 'Email mailboxes' })).toBeVisible();
  await expect(page.locator('.sidebar').getByRole('tablist')).toHaveCount(0);
  await expect(page.locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.thread-row')).toContainText('closer look');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.locator('#compose-from')).toHaveValue('t-info'); await expect(page.locator('#compose-from')).toBeDisabled();
  await page.locator('#compose-subject').fill('Info-only draft'); await page.getByRole('button', { name: 'Save and close draft' }).click();
  await mailbox(page, 'support@example.org');
  await expect(page.locator('.thread-row')).toHaveCount(2); await expect(page.locator('.thread-list')).not.toContainText('closer look');
  await page.getByRole('searchbox', { name: 'Search current mailbox' }).fill('closer look'); await expect(page.locator('.thread-row')).toHaveCount(0);
  await folder(page, 'Drafts'); await expect(page.locator('.draft-row')).toHaveCount(0);
  await folder(page, 'Inbox'); await page.getByRole('button', { name: 'Open A question about inviting our team', exact: true }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('#compose-from')).toHaveValue('t-support'); await expect(page.locator('#compose-from')).toBeDisabled();
  await page.locator('#compose-subject').fill('Support-only reply'); await page.getByRole('button', { name: 'Send locally', exact: true }).click();
  await folder(page, 'Sent'); await expect(page.getByRole('button', { name: 'Open Support-only reply', exact: true })).toBeVisible();
  await mailbox(page, 'info@example.org'); await folder(page, 'Sent'); await expect(page.locator('.thread-row')).toHaveCount(0);
  await folder(page, 'Drafts'); await expect(page.getByRole('button', { name: 'Resume draft: Info-only draft', exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('.breadcrumb-address')).toHaveText('info@example.org');
  await switchDomain(page, 'example.com');
  expect(await page.locator('.compose-button').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(exampleorgColour);
  await switchDomain(page, 'example.org'); await expect(page.locator('.breadcrumb-address')).toHaveText('info@example.org');
  await page.getByRole('tab', { name: 'Open mailbox info@example.org', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Open mailbox support@example.org', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.breadcrumb-address')).toHaveText('support@example.org');
});

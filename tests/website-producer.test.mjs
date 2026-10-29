// Exercise the applied website handler with recorder-only AWS clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const producerRoot = '~/DEV/website';
const available = existsSync(`${producerRoot}/functions/contact/inbox-capture.ts`);
const skip = !available && 'Applied website capture integration is unavailable';
const output = new URL('../.audit/website-contracts/', import.meta.url);
let handler, baselineHandler, clients;
test.before(async () => {
  if (!available) return;
  await mkdir(output, { recursive: true });
  const require = createRequire(`${producerRoot}/package.json`);
  clients = {
    secrets: require('@aws-sdk/client-secrets-manager').SecretsManagerClient,
    ses: require('@aws-sdk/client-sesv2').SESv2Client,
    db: require('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
    s3: require('@aws-sdk/client-s3').S3Client,
  };
  for (const name of ['handler', 'baseline']) {
    const path = `${producerRoot}/functions/contact/handler.ts`;
    const contents = name === 'handler' ? await readFile(path, 'utf8') : execFileSync('patch', ['-R', '-s', '-o', '-', path, fileURLToPath(new URL('../integrations/producer-patches/website-functions_contact_handler.ts.patch', import.meta.url))], { encoding: 'utf8' });
    if (name === 'baseline') {
      const manifest = JSON.parse(await readFile(new URL('../integrations/producer-patches/manifest.json', import.meta.url)));
      assert.equal(createHash('sha256').update(contents).digest('hex'), manifest.edits.find(entry => entry.project === 'website' && entry.path === 'functions/contact/handler.ts').sourceSha256);
    }
    await build({
      stdin: { contents, resolveDir: `${producerRoot}/functions/contact`, loader: 'ts' },
      outfile: fileURLToPath(new URL(`${name}.mjs`, output)), bundle: true, platform: 'node', format: 'esm', target: 'node22',
      plugins: [{ name: 'producer-sdk', setup(build) { build.onResolve({ filter: /^@aws-sdk\// }, args => ({ path: require.resolve(args.path), external: true })); } }],
    });
  }
  const oldOrigin = process.env.ALLOWED_ORIGIN;
  process.env.ALLOWED_ORIGIN = 'https://example.com';
  try {
    handler = (await import(new URL('handler.mjs', output))).handler;
    baselineHandler = (await import(new URL('baseline.mjs', output))).handler;
  } finally { if (oldOrigin === undefined) delete process.env.ALLOWED_ORIGIN; else process.env.ALLOWED_ORIGIN = oldOrigin; }
});
function harness(t) {
  const saved = { ...process.env }, operations = [], requests = [], writes = [];
  Object.assign(process.env, { AWS_REGION: 'us-east-1', ALLOWED_ORIGIN: 'https://example.com', SES_CONFIGURATION_SET: 'example-website-production-contact', SES_IDENTITY_ARN: 'arn:aws:ses:us-east-1:111111111111:identity/example.com', INBOX_CAPTURE_BUCKET: 'mock-only-capture', INBOX_CAPTURE_SOURCE: 'website-production' });
  t.after(() => { for (const key of ['AWS_REGION', 'ALLOWED_ORIGIN', 'SES_CONFIGURATION_SET', 'SES_IDENTITY_ARN', 'INBOX_CAPTURE_BUCKET', 'INBOX_CAPTURE_SOURCE']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  t.mock.method(clients.secrets.prototype, 'send', async () => ({ SecretString: JSON.stringify({ enabled: true, captchaApiKey: 'mock-public-key-for-captcha-only', captchaScriptUrl: 'https://test.us-east-1.captcha-sdk.awswaf.com/test/jsapi.js', fromEmail: 'info@example.com', toEmail: 'owner@example.invalid', rateLimitSalt: 'a'.repeat(48) }) }));
  t.mock.method(clients.db.prototype, 'send', async () => ({}));
  t.mock.method(clients.ses.prototype, 'send', async command => { operations.push('ses'); requests.push(command.input); return { MessageId: 'website-provider-1' }; });
  t.mock.method(clients.s3.prototype, 'send', async command => { operations.push(command.input.Key.endsWith('/message.json') ? 'capture' : 'result'); writes.push(command.input); return {}; });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const event = { httpMethod: 'POST', path: '/contact', headers: { origin: 'https://example.com', 'content-type': 'application/json', 'x-amzn-waf-contact-verified': 'yes' }, requestContext: { identity: { sourceIp: '192.0.2.1' } }, body: JSON.stringify({ name: 'A visitor', email: 'visitor@example.invalid', topic: 'Books', message: 'A question about your book.', website: '', consent: true, token: 'mock-token' }) };
  return { operations, requests, writes, event };
}
test('applied website capture preserves the complete contact request and Reply-To', { skip }, async t => {
  const h = harness(t);
  assert.equal((await handler(h.event)).statusCode, 200);
  assert.deepEqual(h.operations, ['capture', 'ses', 'result']);
  assert.equal((await baselineHandler(h.event)).statusCode, 200);
  const { EmailTags, ...request } = h.requests[0];
  assert.deepEqual(request, h.requests[1]);
  assert.equal(EmailTags.find(tag => tag.Name === 'inbox_source').Value, 'website-production');
  const captured = JSON.parse(h.writes[0].Body);
  assert.equal(captured.kind, 'website_contact');
  assert.deepEqual(captured.request.Content, h.requests[1].Content);
  assert.deepEqual(captured.request.ReplyToAddresses, ['visitor@example.invalid']);
  assert.equal(JSON.parse(h.writes[1].Body).sesMessageId, 'website-provider-1');
});
test('website capture outage fails before sending and status-write failure preserves success', { skip }, async t => {
  const h = harness(t);
  t.mock.method(clients.s3.prototype, 'send', async () => { throw new Error('MockCaptureOutage'); });
  assert.equal((await handler(h.event)).statusCode, 503);
  assert.equal(h.requests.length, 0);
  t.mock.method(clients.s3.prototype, 'send', async command => { if (command.input.Key.endsWith('/result.json')) throw new Error('MockStatusOutage'); return {}; });
  assert.equal((await handler(h.event)).statusCode, 200);
  assert.equal(h.requests.length, 1);
});

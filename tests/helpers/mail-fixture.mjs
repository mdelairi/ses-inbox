// Seeds two domains and four aliases, and delivers composed mail through the real
// ingestion pipeline into a local PostgreSQL started by ./postgres.mjs.
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { createRepository } from '../../mail/repository.mjs';
import { ingestNotification } from '../../mail/ingest.mjs';

export const bucket = 'mail-bucket';

export async function mailFixture(db) {
  await db.reset();
  const domains = { example: randomUUID(), exampleorg: randomUUID() };
  const aliases = { info: randomUUID(), taylor: randomUUID(), trInfo: randomUUID(), support: randomUUID() };
  for (const [domainId, name] of [[domains.example, 'example.com'], [domains.exampleorg, 'example.org']]) await db.pool.query('INSERT INTO mail.domains VALUES($1,$2,$3,1)', [domainId, name, name]);
  for (const [domainId, aliasId, address, receive] of [[domains.example, aliases.info, 'info@example.com', true], [domains.example, aliases.taylor, 'taylor@example.com', true], [domains.exampleorg, aliases.trInfo, 'info@example.org', true], [domains.exampleorg, aliases.support, 'support@example.org', false]]) {
    await db.pool.query('INSERT INTO mail.aliases VALUES($1,$2,$3,$4,$5,true,false,$6,1)', [domainId, aliasId, address, address, receive, '']);
  }
  const stored = new Map();
  const objects = {
    async getRaw(b, key) { if (!stored.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); return stored.get(key); },
    async get(key) { if (!stored.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); return stored.get(key).toString(); },
    async getBytes(key) { if (!stored.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); return stored.get(key); },
    async put(key, body) { stored.set(key, Buffer.from(body)); },
    async remove(key) { stored.delete(key); },
    async uploadUrl(key, sha256) { return { url: `https://objects.invalid/${key}`, headers: { 'x-amz-checksum-sha256': sha256 } }; },
    async downloadUrl(key) { return `https://objects.invalid/${key}`; },
  };
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const repo = createRepository(db.pool);
  async function deliver(recipients, options = {}, verdicts = {}) {
    const key = `incoming/${randomUUID()}`;
    stored.set(key, await new MailComposer({ from: 'Avery <avery@example.net>', to: recipients, subject: 'Hello project', text: 'A new idea about invoices', ...options }).compile().build());
    clock += 60000;
    const notification = { notificationType: 'Received', mail: { messageId: `ses-${key}`, timestamp: new Date(clock).toISOString() },
      receipt: { recipients, action: { type: 'S3', bucketName: bucket, objectKey: key }, spamVerdict: { status: verdicts.spam || 'PASS' }, virusVerdict: { status: verdicts.virus || 'PASS' } } };
    return (await ingestNotification({ notification, repo, objects, bucket, now: () => clock })).results;
  }
  return { domains, aliases, objects, stored, repo, deliver, now: () => clock };
}

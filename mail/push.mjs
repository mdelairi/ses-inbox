import { createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value || '') ? value : fail('Invalid identifier');
const utc = value => value == null ? null : new Date(String(value).replace(' ', 'T') + 'Z').toISOString();
// Only the browsers' own push services: a stored endpoint can never point the worker at another host.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
const KEY = /^[A-Za-z0-9_-]+$/;

// vapid() resolves { publicKey, privateKey, subject }; send is web-push's sender, injectable for tests.
export function createPush({ pool, vapid, send = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options), now = Date.now }) {
  return {
    async key() { return { publicKey: (await vapid()).publicKey }; },

    async devices() {
      const { rows } = await pool.query('SELECT subscription_id, label, created_at::text AS created_at, last_success_at::text AS last_success_at FROM mail.push_subscriptions ORDER BY created_at');
      return rows.map(row => ({ id: row.subscription_id, label: row.label, createdAt: utc(row.created_at), lastSuccessAt: utc(row.last_success_at) }));
    },

    // Re-enrolling the same browser updates its keys instead of adding a second device.
    async subscribe({ subscription, label }) {
      const endpoint = String(subscription?.endpoint || ''), p256dh = String(subscription?.keys?.p256dh || ''), auth = String(subscription?.keys?.auth || '');
      let host;
      try { const url = new URL(endpoint); host = url.protocol === 'https:' && !url.port && !url.username ? url.hostname : ''; } catch { host = ''; }
      if (endpoint.length > 2048 || !PUSH_HOSTS.some(pattern => pattern.test(host))) fail('This browser’s push service is not supported.');
      if (!KEY.test(p256dh) || p256dh.length < 80 || p256dh.length > 128 || !KEY.test(auth) || auth.length < 16 || auth.length > 64) fail('The browser sent an invalid subscription.');
      const name = String(label || 'This device').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || 'This device', hash = sha256(endpoint), at = new Date(now()).toISOString();
      const { rows: [existing] } = await pool.query('SELECT subscription_id FROM mail.push_subscriptions WHERE endpoint_hash=$1', [hash]);
      if (existing) {
        await pool.query('UPDATE mail.push_subscriptions SET p256dh=$2, auth=$3, label=$4, revision=revision+1 WHERE subscription_id=$1', [existing.subscription_id, p256dh, auth, name]);
        return { id: existing.subscription_id };
      }
      const id = randomUUID();
      await pool.query('INSERT INTO mail.push_subscriptions(subscription_id,endpoint_hash,endpoint,p256dh,auth,label,created_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)', [id, hash, endpoint, p256dh, auth, name, at]);
      return { id };
    },

    async remove({ id }) {
      const { rowCount } = await pool.query('DELETE FROM mail.push_subscriptions WHERE subscription_id=$1', [uuid(id)]);
      return { removed: rowCount };
    },

    // Payloads carry sender and subject only, never body text. Endpoints the push service
    // reports gone (404/410) are removed; other failures leave the device enrolled.
    async notify(message) {
      const { rows } = await pool.query('SELECT subscription_id, endpoint, p256dh, auth FROM mail.push_subscriptions');
      if (!rows.length) return { sent: 0, removed: 0, failed: 0 };
      const keys = await vapid(), payload = JSON.stringify(message), result = { sent: 0, removed: 0, failed: 0 };
      for (const row of rows) {
        try {
          await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, { vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 86400, urgency: 'high', timeout: 10000 });
          await pool.query('UPDATE mail.push_subscriptions SET last_success_at=$2 WHERE subscription_id=$1', [row.subscription_id, new Date(now()).toISOString()]);
          result.sent++;
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) { await pool.query('DELETE FROM mail.push_subscriptions WHERE subscription_id=$1', [row.subscription_id]); result.removed++; }
          else result.failed++;
        }
      }
      return result;
    },
  };
}

// New-mail notification: who and what, plus where to open it.
export function newMailNotification({ domain, mailbox, threadId, messageId, parsed }) {
  return { title: (parsed.from.name || parsed.from.address || 'New mail').slice(0, 120), body: (parsed.subject || '(No subject)').slice(0, 200), tag: messageId,
    url: `/?${new URLSearchParams({ domain, mailbox, thread: threadId })}` };
}

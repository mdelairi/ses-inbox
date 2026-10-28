import { randomUUID } from 'node:crypto';

export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value || '') ? value : fail('Invalid identifier');
const utc = value => new Date(String(value).replace(' ', 'T') + 'Z').toISOString();

function validDraft(draft, domainId) {
  if (!draft || typeof draft !== 'object') fail('Invalid draft');
  for (const field of ['to', 'cc', 'bcc']) if (!Array.isArray(draft[field] ?? []) || (draft[field] ?? []).length > 50) fail('Too many recipients');
  if (String(draft.subject ?? '').length > 998) fail('Shorten the subject.');
  for (const file of draft.attachments ?? []) if (typeof file?.key !== 'string' || !file.key.startsWith(`uploads/${domainId}/`) || file.key.includes('..')) fail('Attachment upload is missing.');
  const text = JSON.stringify(draft);
  if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) fail('This draft is too large.', 413);
  return text;
}

// Draft bodies are immutable S3 objects; the row's revision is a compare-and-swap guard.
export function createDrafts({ pool, objects, mailbox, now = Date.now }) {
  return {
    async list({ mailbox: address }) {
      const scope = await mailbox.alias(address);
      const { rows } = await pool.query('SELECT draft_id, subject, updated_at::text AS updated_at, revision FROM mail.drafts WHERE domain_id=$1 AND alias_id=$2 ORDER BY updated_at DESC', [scope.domainId, scope.aliasId]);
      return rows.map(row => ({ id: row.draft_id, subject: row.subject, updatedAt: utc(row.updated_at), revision: row.revision }));
    },
    async get({ mailbox: address, id }) {
      const scope = await mailbox.alias(address);
      const { rows: [row] } = await pool.query('SELECT object_key, revision FROM mail.drafts WHERE domain_id=$1 AND alias_id=$2 AND draft_id=$3', [scope.domainId, scope.aliasId, uuid(id)]);
      if (!row) fail('Draft not found', 404);
      return { id, revision: row.revision, draft: JSON.parse(await objects.get(row.object_key)) };
    },
    // revision 0 creates. A stale revision is a conflict, never a silent overwrite.
    async save({ mailbox: address, id, revision, draft }) {
      const scope = await mailbox.alias(address);
      uuid(id);
      if (!Number.isSafeInteger(revision) || revision < 0) fail('Invalid revision');
      const text = validDraft(draft, scope.domainId), key = `drafts/${scope.domainId}/${scope.aliasId}/${id}/${randomUUID()}.json`, at = new Date(now()).toISOString();
      const { rows: [previous] } = await pool.query('SELECT object_key FROM mail.drafts WHERE domain_id=$1 AND alias_id=$2 AND draft_id=$3', [scope.domainId, scope.aliasId, id]);
      await objects.put(key, text, 'application/json');
      const subject = String(draft.subject ?? '').slice(0, 998);
      const { rowCount } = revision === 0
        ? await pool.query('INSERT INTO mail.drafts(domain_id,alias_id,draft_id,object_key,subject,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING', [scope.domainId, scope.aliasId, id, key, subject, at])
        : await pool.query('UPDATE mail.drafts SET object_key=$4, subject=$5, updated_at=$6, revision=revision+1 WHERE domain_id=$1 AND alias_id=$2 AND draft_id=$3 AND revision=$7', [scope.domainId, scope.aliasId, id, key, subject, at, revision]);
      if (!rowCount) { await objects.remove(key).catch(() => {}); fail('This draft was changed on another device. Your copy is kept in this browser.', 409); }
      if (previous) await objects.remove(previous.object_key).catch(() => {});
      return { id, revision: revision + 1, updatedAt: at };
    },
    async remove({ mailbox: address, id }) {
      const scope = await mailbox.alias(address);
      const { rows: [row] } = await pool.query('SELECT object_key FROM mail.drafts WHERE domain_id=$1 AND alias_id=$2 AND draft_id=$3', [scope.domainId, scope.aliasId, uuid(id)]);
      if (!row) return { removed: false };
      await pool.query('DELETE FROM mail.drafts WHERE domain_id=$1 AND alias_id=$2 AND draft_id=$3', [scope.domainId, scope.aliasId, id]);
      await objects.remove(row.object_key).catch(() => {});
      return { removed: true };
    },
    // Uploads go to a fresh per-domain key; send/draft validation re-checks size and SHA-256.
    async uploadTicket({ mailbox: address, sha256, size }) {
      const scope = await mailbox.alias(address);
      if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES) fail('Use a file up to 25 MB.');
      const key = `uploads/${scope.domainId}/${randomUUID()}/${sha256}`;
      return { key, ...(await objects.uploadUrl(key, sha256, size)) };
    },
  };
}

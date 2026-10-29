import { transaction } from './repository.mjs';

export const DAY = 86400000;
export const RETENTION_MS = 29 * DAY;
export const utcMillis = value => +new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(String(value)) ? value : String(value).replace(' ', 'T') + 'Z');
export const ledgerKey = (domain, alias, message) => `tombstones/${domain}/${alias}/${message}.json`;
const placeholders = values => values.map((_, i) => `$${i + 3}`).join(',');

// Durable S3 intent is written before committing the SQL deletion. A failed database
// commit can conservatively suppress a restore, but an acknowledged deletion has no ledger gap.
export async function recordDeletion(objects, domainId, aliasId, messageId, deletedAt) {
  await objects.put(ledgerKey(domainId, aliasId, messageId), JSON.stringify({ domain_id: domainId, alias_id: aliasId, message_id: messageId, deleted_at: deletedAt }), 'application/json');
}

export async function purgeMessage({ pool, objects, domainId, messageId }) {
  const args = [domainId, messageId];
  const { rows: [job] } = await pool.query('SELECT complete FROM mail.purge_jobs WHERE domain_id=$1 AND message_id=$2', args);
  if (!job || job.complete) return false;
  if ((await pool.query('SELECT 1 FROM mail.mailbox_entries WHERE domain_id=$1 AND message_id=$2 LIMIT 1', args)).rowCount) throw new Error('RetiredMessageStillReferenced');
  const prefix = `mail/${domainId}/${messageId}/`;
  // Listing makes cleanup resumable even when a previous attempt removed the manifest.
  for (const key of await objects.listCurrent(prefix)) {
    if (!key.startsWith(prefix)) throw new Error('UnexpectedPurgeKey');
    await objects.remove(key);
  }
  const { rows: groups } = await pool.query('SELECT generation, field, section, max(position) AS last FROM mail.search_positions WHERE domain_id=$1 AND message_id=$2 GROUP BY generation, field, section', args);
  for (const group of groups) for (let below = 2000; below <= group.last + 2000; below += 2000) {
    await pool.query('DELETE FROM mail.search_positions WHERE domain_id=$1 AND message_id=$2 AND generation=$3 AND field=$4 AND section=$5 AND position<$6', [...args, group.generation, group.field, group.section, below]);
  }
  // Bound every deletion, including messages with many references or send attempts.
  for (const [table, key] of [['message_ids', 'rfc_hash'], ['send_attempts', 'attempt_id']]) {
    for (;;) {
      const { rows } = await pool.query(`SELECT ${key} FROM mail.${table} WHERE domain_id=$1 AND message_id=$2 LIMIT 2000`, args);
      if (!rows.length) break;
      await pool.query(`DELETE FROM mail.${table} WHERE domain_id=$1 AND message_id=$2 AND ${key} IN (${placeholders(rows)})`, [...args, ...rows.map(row => row[key])]);
    }
  }
  await transaction(pool, async client => {
    await client.query('DELETE FROM mail.messages WHERE domain_id=$1 AND message_id=$2', args);
    await client.query('UPDATE mail.purge_jobs SET content_removed=true, revision=revision+1 WHERE domain_id=$1 AND message_id=$2', args);
  });
  return true;
}

// Noncurrent age starts at the immediate successor (including a delete marker), not
// the old object's creation date. Current retained objects are never age-expired.
export function expiredVersions(versions, now) {
  const groups = new Map(), expired = [];
  for (const v of versions) {
    if (!groups.has(v.key)) groups.set(v.key, []);
    groups.get(v.key).push(v);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => +new Date(b.lastModified) - +new Date(a.lastModified) || Number(b.isLatest) - Number(a.isLatest));
    for (let i = 1; i < items.length; i++) if (now - +new Date(items[i - 1].lastModified) >= RETENTION_MS && !items[i].isLatest) expired.push(items[i]);
  }
  return expired;
}

export async function cleanupMail({ pool, objects, now = Date.now() }) {
  const result = { purged: 0, versions: 0, completed: 0 };
  // Backfill retirement jobs left by releases that only attempted inline purge.
  const { rows: orphans } = await pool.query('SELECT m.domain_id, m.message_id, max(t.deleted_at)::text AS deleted_at FROM mail.messages m JOIN mail.deletion_tombstones t ON t.domain_id=m.domain_id AND t.message_id=m.message_id WHERE NOT EXISTS (SELECT 1 FROM mail.mailbox_entries e WHERE e.domain_id=m.domain_id AND e.message_id=m.message_id) GROUP BY m.domain_id, m.message_id LIMIT 100');
  for (const row of orphans) await pool.query('INSERT INTO mail.purge_jobs(domain_id,message_id,deleted_at,purge_after,content_removed,complete,revision) VALUES($1,$2,$3,$4,false,false,1) ON CONFLICT DO NOTHING', [row.domain_id, row.message_id, row.deleted_at, new Date(utcMillis(row.deleted_at) + RETENTION_MS).toISOString()]);
  const { rows: jobs } = await pool.query('SELECT domain_id, message_id, purge_after::text AS purge_after, content_removed FROM mail.purge_jobs WHERE complete=false ORDER BY deleted_at LIMIT 100');
  for (const job of jobs) {
    const args = [job.domain_id, job.message_id];
    if (!job.content_removed) { await purgeMessage({ pool, objects, domainId: job.domain_id, messageId: job.message_id }); result.purged++; }
    if (now < utcMillis(job.purge_after)) continue;
    if ((await pool.query('SELECT 1 FROM mail.mailbox_entries WHERE domain_id=$1 AND message_id=$2 LIMIT 1', args)).rowCount) throw new Error('RetiredMessageStillReferenced');
    const prefix = `mail/${job.domain_id}/${job.message_id}/`;
    for (const version of await objects.versions(prefix)) { await objects.removeVersion(version.key, version.versionId); result.versions++; }
    if ((await objects.versions(prefix)).length) throw new Error('RetiredVersionsRemain');
    await pool.query('UPDATE mail.purge_jobs SET complete=true, revision=revision+1 WHERE domain_id=$1 AND message_id=$2', args);
    result.completed++;
  }
  // A deterministic upper bound for intake copies, independent of lifecycle lag.
  const intake = await objects.versions('incoming/'), oldIntake = new Set(intake.filter(v => v.isLatest && now - +new Date(v.lastModified) >= 15 * DAY).map(v => v.key));
  for (const version of intake) if (oldIntake.has(version.key)) { await objects.removeVersion(version.key, version.versionId); result.versions++; }
  for (const prefix of ['mail/', 'drafts/', 'uploads/', 'incoming/']) {
    for (const version of expiredVersions(await objects.versions(prefix), now)) { await objects.removeVersion(version.key, version.versionId); result.versions++; }
  }
  const { rows: [late] } = await pool.query('SELECT count(*)::int AS n FROM mail.purge_jobs WHERE complete=false AND purge_after<$1', [new Date(now - DAY).toISOString()]);
  if (late.n) throw new Error('RetentionDeadlineBreached');
  return result;
}

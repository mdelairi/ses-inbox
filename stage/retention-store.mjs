import { entryKey, hash } from './retention.mjs';

const issue = (message, status = 409) => Object.assign(new Error(message), { name: 'MailError', status });
const iso = value => value instanceof Date ? value.toISOString() : new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z').toISOString();
export function createHeads(pool) {
  const get = async owner => {
    const { rows } = await pool.query('SELECT revision,object_key,digest,write_id,maintenance_token,maintenance_started_at FROM inbox_stage.workspace WHERE owner_key=$1', [owner]);
    const row = rows[0]; return row && { revision: row.revision, objectKey: row.object_key, digest: row.digest, writeId: row.write_id, maintenanceToken: row.maintenance_token, maintenanceStartedAt: row.maintenance_started_at };
  };
  async function tombstones(owner) {
    const { rows } = await pool.query('SELECT kind,domain,item_id,mailbox,deleted_at::text AS deleted_at FROM inbox_stage.tombstones WHERE owner_key=$1', [owner]);
    return rows.map(row => ({ kind: row.kind, domain: row.domain, id: row.item_id, mailbox: row.mailbox, deletedAt: iso(row.deleted_at) }));
  }
  async function retired(owner) {
    const { rows } = await pool.query('SELECT object_key,kind,retired_at::text AS retired_at,purge_after::text AS purge_after,content_sha FROM inbox_stage.retired_objects WHERE owner_key=$1', [owner]);
    return rows.map(row => ({ objectKey: row.object_key, kind: row.kind, retiredAt: iso(row.retired_at), purgeAfter: iso(row.purge_after), digest: row.content_sha }));
  }
  async function insertRetired(client, owner, item) {
    await client.query('INSERT INTO inbox_stage.retired_objects(owner_key,object_key_hash,object_key,kind,retired_at,purge_after,content_sha) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [owner, hash(item.objectKey), item.objectKey, item.kind, item.retiredAt, item.purgeAfter, item.digest || null]);
  }
  return {
    get, tombstones, retired,
    async owners() { return (await pool.query('SELECT owner_key FROM inbox_stage.workspace')).rows.map(row => row.owner_key); },
    async compareAndSwap(owner, revision, next, changes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = revision === 0
          ? await client.query('INSERT INTO inbox_stage.workspace(owner_key,revision,object_key,digest,write_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [owner, next.revision, next.objectKey, next.digest, next.writeId])
          : await client.query('UPDATE inbox_stage.workspace SET revision=$2,object_key=$3,digest=$4,write_id=$5 WHERE owner_key=$1 AND revision=$6 AND maintenance_token IS NULL', [owner, next.revision, next.objectKey, next.digest, next.writeId, revision]);
        if (!rowCount) { await client.query('ROLLBACK'); if ((await get(owner))?.maintenanceToken) throw issue('Workspace cleanup is running. Retry shortly.', 503); return false; }
        const blocked = new Set((await client.query('SELECT entry_key FROM inbox_stage.tombstones WHERE owner_key=$1', [owner])).rows.map(row => row.entry_key));
        if (changes.candidateEntries.some(entry => blocked.has(entryKey(entry)))) throw issue('Permanently deleted entries cannot be restored. Reload the shared workspace.');
        if (changes.candidateFiles.length) {
          const placeholders = changes.candidateFiles.map((_, i) => `$${i + 2}`).join(',');
          const { rowCount } = await client.query(`SELECT object_key_hash FROM inbox_stage.retired_objects WHERE owner_key=$1 AND object_key_hash IN (${placeholders})`, [owner, ...changes.candidateFiles.map(hash)]);
          if (rowCount) throw issue('An attachment was retired. Reattach its file before saving.');
        }
        for (const entry of changes.deletions) await client.query('INSERT INTO inbox_stage.tombstones(owner_key,entry_key,kind,domain,item_id,mailbox,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [owner, entryKey(entry), entry.kind, entry.domain, entry.id, entry.mailbox, changes.at]);
        for (const item of changes.retirements) await insertRetired(client, owner, item);
        await client.query('COMMIT'); return true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (['40001', '23505'].includes(error.code)) return false;
        throw error;
      } finally { client.release(); }
    },
    async claim(owner, token) {
      // Only the worker can replace a lock left by a timed-out invocation. All
      // S3 deletion targets are durably retired first, so late requests stay fenced.
      return (await pool.query("UPDATE inbox_stage.workspace SET maintenance_token=$2,maintenance_started_at=CURRENT_TIMESTAMP WHERE owner_key=$1 AND (maintenance_token IS NULL OR maintenance_started_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')", [owner, token])).rowCount === 1;
    },
    async release(owner, token) { await pool.query('UPDATE inbox_stage.workspace SET maintenance_token=NULL,maintenance_started_at=NULL WHERE owner_key=$1 AND maintenance_token=$2', [owner, token]); },
    async retire(owner, token, item) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('UPDATE inbox_stage.workspace SET maintenance_token=$2 WHERE owner_key=$1 AND maintenance_token=$2', [owner, token]);
        if (!locked.rowCount) throw new Error('MaintenanceFenceLost');
        await insertRetired(client, owner, item); await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async forgetRetired(owner, token, key) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (!(await client.query('UPDATE inbox_stage.workspace SET maintenance_token=$2 WHERE owner_key=$1 AND maintenance_token=$2', [owner, token])).rowCount) throw new Error('MaintenanceFenceLost');
        await client.query('DELETE FROM inbox_stage.retired_objects WHERE owner_key=$1 AND object_key_hash=$2', [owner, hash(key)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async publishRecovery(owner, token, revision, next, previous) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const changed = await client.query('UPDATE inbox_stage.workspace SET revision=$3,object_key=$4,digest=$5,write_id=$6 WHERE owner_key=$1 AND maintenance_token=$2 AND revision=$7', [owner, token, next.revision, next.objectKey, next.digest, next.writeId, revision]);
        if (!changed.rowCount) throw new Error('RecoveryFenceLost');
        await insertRetired(client, owner, previous); await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
  };
}

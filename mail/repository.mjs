import { randomUUID } from 'node:crypto';

// Timestamps are zone-less UTC: always write ISO strings (pg serializes Date params in
// local time) and read them back as ::text.
const POSITION_BATCH = 500;
const placeholders = (values, offset = 0) => values.map((_, i) => `$${i + 1 + offset}`).join(',');
const iso = value => value == null ? null : (value instanceof Date ? value : new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : String(value).replace(' ', 'T') + 'Z')).toISOString();
export const retryable = error => ['40001', '40P01', 'OC000', 'OC001'].includes(error?.code);

// DSQL uses optimistic concurrency; retry whole transactions a bounded number of times.
export async function transaction(pool, work, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (!retryable(error) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt * Math.random()));
    } finally { client.release(); }
  }
}

export function createRepository(pool) {
  return {
    async aliasesForAddresses(addresses) {
      if (!addresses.length) return [];
      const { rows } = await pool.query(`SELECT domain_id, alias_id, address, receive_enabled, send_enabled FROM mail.aliases WHERE address IN (${placeholders(addresses)})`, addresses);
      return rows.map(row => ({ domainId: row.domain_id, aliasId: row.alias_id, address: row.address, receiveEnabled: row.receive_enabled, sendEnabled: row.send_enabled }));
    },

    // Returns { status: 'claimed', messageId, generation, token } | { status: 'duplicate' | 'failed' | 'busy' }.
    async claimReceipt({ domainId, receiptKey, now, leaseMs = 5 * 60000 }) {
      const token = randomUUID(), until = new Date(now + leaseMs).toISOString();
      const inserted = await pool.query('INSERT INTO mail.ingestion_receipts(domain_id,receipt_key,message_id,state,generation,lease_token,lease_until,attempts,revision) VALUES($1,$2,$3,$4,1,$5,$6,1,1) ON CONFLICT DO NOTHING',
        [domainId, receiptKey, randomUUID(), 'processing', token, until]);
      // Read timestamps as text: pg would otherwise interpret zone-less values in local time.
      const { rows: [row] } = await pool.query('SELECT message_id, state, generation, lease_until::text AS lease_until, revision FROM mail.ingestion_receipts WHERE domain_id=$1 AND receipt_key=$2', [domainId, receiptKey]);
      if (inserted.rowCount) return { status: 'claimed', messageId: row.message_id, generation: row.generation, token };
      if (row.state === 'published') return { status: 'duplicate', messageId: row.message_id };
      if (row.state === 'failed') return { status: 'failed', messageId: row.message_id };
      if (+new Date(iso(row.lease_until)) > now) return { status: 'busy' };
      // A crashed attempt's partial index rows stay invisible under its old generation.
      const taken = await pool.query('UPDATE mail.ingestion_receipts SET lease_token=$3, lease_until=$4, generation=generation+1, attempts=attempts+1, revision=revision+1 WHERE domain_id=$1 AND receipt_key=$2 AND revision=$5 AND state=$6',
        [domainId, receiptKey, token, until, row.revision, 'processing']);
      return taken.rowCount ? { status: 'claimed', messageId: row.message_id, generation: row.generation + 1, token } : { status: 'busy' };
    },

    async failReceipt({ domainId, receiptKey, token, error }) {
      await pool.query('UPDATE mail.ingestion_receipts SET state=$4, error=$5, lease_token=NULL, revision=revision+1 WHERE domain_id=$1 AND receipt_key=$2 AND lease_token=$3', [domainId, receiptKey, token, 'failed', String(error).slice(0, 500)]);
    },

    async threadFor(domainId, rfcHashes) {
      if (!rfcHashes.length) return null;
      const { rows } = await pool.query(`SELECT thread_id FROM mail.message_ids WHERE domain_id=$1 AND rfc_hash IN (${placeholders(rfcHashes, 1)}) LIMIT 1`, [domainId, ...rfcHashes]);
      return rows[0]?.thread_id || null;
    },

    // Unpublished generations are never searched, so batches may commit independently.
    async insertPositions({ domainId, messageId, generation, rows }) {
      for (let start = 0; start < rows.length; start += POSITION_BATCH) {
        const batch = rows.slice(start, start + POSITION_BATCH), values = [];
        const tuples = batch.map((row, i) => { values.push(row.field, row.section, row.position, row.token); return `($1,$2,$3,$${4 + i * 4},$${5 + i * 4},$${6 + i * 4},$${7 + i * 4})`; });
        await pool.query(`INSERT INTO mail.search_positions(domain_id,message_id,generation,field,section,position,token) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, [domainId, messageId, generation, ...values]);
      }
    },

    // Atomically makes a fully stored message visible to each receiving alias.
    async publish({ receipt, message, rfcHash, aliasIds, folder }) {
      return transaction(pool, async client => {
        const owned = await client.query('UPDATE mail.ingestion_receipts SET state=$4, lease_token=NULL, revision=revision+1 WHERE domain_id=$1 AND receipt_key=$2 AND lease_token=$3 AND state=$5',
          [message.domainId, receipt.key, receipt.token, 'published', 'processing']);
        if (!owned.rowCount) throw new Error('IngestionLeaseLost');
        const m = message;
        await client.query(`INSERT INTO mail.messages(domain_id,message_id,thread_id,received_at,sent_at,subject,sender_name,sender_address,recipients_json,snippet,has_attachments,source,environment,verdicts_json,quarantined,object_manifest_key,search_generation,search_partial,tokenizer_version,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1) ON CONFLICT DO NOTHING`,
        [m.domainId, m.messageId, m.threadId, m.receivedAt, m.sentAt, m.subject, m.senderName, m.senderAddress, JSON.stringify(m.recipients), m.snippet, m.hasAttachments, m.source, m.environment, JSON.stringify(m.verdicts), m.quarantined, m.manifestKey, m.generation, m.searchPartial, m.tokenizerVersion]);
        if (rfcHash) await client.query('INSERT INTO mail.message_ids(domain_id,rfc_hash,message_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [m.domainId, rfcHash, m.messageId, m.threadId]);
        const { rows } = await client.query(`SELECT alias_id FROM mail.deletion_tombstones WHERE domain_id=$1 AND message_id=$2 AND alias_id IN (${placeholders(aliasIds, 2)})`, [m.domainId, m.messageId, ...aliasIds]);
        const blocked = new Set(rows.map(row => row.alias_id)), delivered = aliasIds.filter(id => !blocked.has(id));
        for (const aliasId of delivered) {
          await client.query('INSERT INTO mail.mailbox_entries(domain_id,alias_id,message_id,thread_id,folder,is_read,received_at,revision) VALUES($1,$2,$3,$4,$5,false,$6,1) ON CONFLICT DO NOTHING',
            [m.domainId, aliasId, m.messageId, m.threadId, folder, m.receivedAt]);
        }
        return { delivered };
      });
    },
  };
}

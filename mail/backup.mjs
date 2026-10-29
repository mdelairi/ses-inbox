// Logical, self-contained backups: a consistent SQL snapshot plus independent copies
// of its exact objects. Only manifest.json commits a usable backup; partial runs expire.
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { RETENTION_MS, utcMillis } from './retention.mjs';

export const COLUMNS = Object.fromEntries(Object.entries({
  domains: 'domain_id name label revision',
  aliases: 'domain_id alias_id address display_name receive_enabled send_enabled is_default signature revision',
  messages: 'domain_id message_id thread_id received_at sent_at subject sender_name sender_address recipients_json snippet has_attachments source environment verdicts_json quarantined object_manifest_key search_generation search_partial tokenizer_version revision',
  message_ids: 'domain_id rfc_hash message_id thread_id',
  mailbox_entries: 'domain_id alias_id message_id thread_id folder is_read received_at revision',
  search_positions: 'domain_id message_id generation field section position token',
  drafts: 'domain_id alias_id draft_id object_key subject updated_at revision',
  deletion_tombstones: 'domain_id alias_id message_id deleted_at',
  ingestion_receipts: 'domain_id receipt_key message_id state generation lease_token lease_until attempts error revision',
  send_attempts: 'domain_id attempt_id alias_id message_id state ses_message_id detail updated_at revision',
  purge_jobs: 'domain_id message_id deleted_at purge_after content_removed complete revision',
}).map(([table, columns]) => [table, columns.split(' ')]));
const TIMES = new Set(['received_at', 'sent_at', 'updated_at', 'deleted_at', 'lease_until', 'purge_after']);
const identity = row => `${row.domain_id}/${row.message_id}`;
const entryIdentity = row => `${row.domain_id}/${row.alias_id}/${row.message_id}`;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validLedger(row) {
  if (!row || !['domain_id', 'alias_id', 'message_id'].every(key => uuid.test(row[key])) || !Number.isFinite(utcMillis(row.deleted_at))) throw new Error('InvalidDeletionLedger');
  return row;
}
const safeKey = key => typeof key === 'string' && /^(mail|drafts|uploads|incoming)\//.test(key) && !key.includes('..') && !key.includes('\\');
function validateTables(tables) {
  if (!tables || Object.keys(tables).length !== Object.keys(COLUMNS).length) throw new Error('InvalidBackupSchema');
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!Array.isArray(tables[table]) || tables[table].length > 100000) throw new Error('InvalidBackupRows');
    for (const row of tables[table]) if (!row || Object.keys(row).length !== columns.length || columns.some(key => !Object.hasOwn(row, key))) throw new Error('InvalidBackupColumns');
  }
}

export async function captureTables(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const tables = {};
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const select = columns.map(name => TIMES.has(name) ? `${name}::text AS ${name}` : name).join(',');
      tables[table] = (await client.query(`SELECT ${select} FROM mail.${table} LIMIT 100001`)).rows;
      if (tables[table].length > 100000) throw new Error('BackupRowLimitExceeded');
    }
    await client.query('COMMIT');
    // Orphan/retired content is never copied into a newer backup.
    return filterTables(tables, tables.deletion_tombstones);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
export function filterTables(input, latestLedger) {
  validateTables(input);
  const tables = structuredClone(input), deleted = new Map();
  for (const row of [...tables.deletion_tombstones, ...latestLedger]) { validLedger(row); deleted.set(entryIdentity(row), row); }
  tables.deletion_tombstones = [...deleted.values()];
  tables.mailbox_entries = tables.mailbox_entries.filter(row => !deleted.has(entryIdentity(row)));
  const retained = new Set(tables.mailbox_entries.map(identity));
  for (const table of ['messages', 'message_ids', 'search_positions', 'send_attempts']) tables[table] = tables[table].filter(row => retained.has(identity(row)));
  // Never resume an in-flight send from a recovery copy.
  for (const row of tables.send_attempts) if (row.state === 'sending') { row.state = 'uncertain'; row.detail = 'Restored send; outcome requires review.'; }
  tables.ingestion_receipts = tables.ingestion_receipts.filter(row => row.state === 'published').map(row => ({ ...row, lease_token: null, error: null }));
  return tables;
}

// Fetch one object at a time; total body size never accumulates in Lambda memory.
export async function createBackup({ pool, sourceObjects, backupObjects, source, now = Date.now, checkTime = () => {} }) {
  const started = now(), prefix = `snapshots/${started}-${randomUUID()}/`, tables = await captureTables(pool);
  const objects = new Map();
  async function copy(key) {
    if (!safeKey(key)) throw new Error('InvalidBackupObjectKey');
    if (objects.has(key)) return objects.get(key);
    checkTime();
    const bytes = await sourceObjects.getRecoverable(key);
    if (bytes.length > 50 * 1024 * 1024) throw new Error('BackupObjectLimitExceeded');
    const record = { key, backupKey: `${prefix}objects/${objects.size}`, sha256: digest(bytes), size: bytes.length };
    await backupObjects.put(record.backupKey, bytes);
    objects.set(key, record);
    return record;
  }
  for (const message of tables.messages) {
    const record = await copy(message.object_manifest_key), manifest = JSON.parse(await backupObjects.get(record.backupKey));
    const prefix = `mail/${message.domain_id}/${message.message_id}/`;
    if (![manifest.body, ...(manifest.producerRecord ? [manifest.producerRecord] : []), ...manifest.parts.map(part => part.key)].every(key => typeof key === 'string' && key.startsWith(prefix))) throw new Error('InvalidMessageManifest');
    if (!manifest.raw?.key?.startsWith(prefix)) throw new Error('RawPreservationRequired');
    for (const key of [manifest.body, manifest.raw.key, ...(manifest.producerRecord ? [manifest.producerRecord] : []), ...manifest.parts.map(part => part.key)]) await copy(key);
  }
  for (const draft of tables.drafts) {
    const record = await copy(draft.object_key), content = JSON.parse(await backupObjects.get(record.backupKey));
    for (const file of content.attachments || []) {
      if (!file.key?.startsWith(`uploads/${draft.domain_id}/`)) throw new Error('InvalidDraftObjectKey');
      await copy(file.key);
    }
  }
  const tableText = JSON.stringify(tables);
  if (Buffer.byteLength(tableText) > 64 * 1024 * 1024) throw new Error('BackupMetadataLimitExceeded');
  const bytes = gzipSync(tableText);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('BackupMetadataLimitExceeded');
  const tablesKey = `${prefix}tables.json.gz`;
  await backupObjects.put(tablesKey, bytes, 'application/gzip');
  const manifest = { version: 1, source, createdAt: new Date(started).toISOString(), expiresAt: new Date(started + RETENTION_MS).toISOString(), tablesKey, tablesSha256: digest(bytes), objects: [...objects.values()] };
  checkTime();
  await backupObjects.put(`${prefix}manifest.json`, JSON.stringify(manifest), 'application/json');
  return { key: `${prefix}manifest.json`, messages: tables.messages.length, objects: objects.size, bytes: [...objects.values()].reduce((sum, row) => sum + row.size, bytes.length) };
}

export async function loadBackup({ backupObjects, key, now = Date.now() }) {
  if (!/^snapshots\/\d{13}-[a-f0-9-]+\/manifest\.json$/.test(key)) throw new Error('InvalidBackupKey');
  const manifest = JSON.parse(await backupObjects.get(key)), prefix = key.slice(0, -'manifest.json'.length);
  const created = +new Date(manifest.createdAt), expires = +new Date(manifest.expiresAt);
  if (manifest.version !== 1 || !Number.isFinite(created) || created > now || expires !== created + RETENTION_MS || now >= expires || Number(prefix.split('/')[1].slice(0, 13)) !== created) throw new Error('BackupExpiredOrInvalid');
  if (manifest.tablesKey !== `${prefix}tables.json.gz` || !Array.isArray(manifest.objects)) throw new Error('InvalidBackupManifest');
  const seen = new Set();
  for (const row of manifest.objects) {
    if (!safeKey(row.key) || !new RegExp(`^${prefix}objects/\\d+$`).test(row.backupKey) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0 || seen.has(row.key)) throw new Error('InvalidBackupManifest');
    seen.add(row.key);
  }
  const bytes = await backupObjects.getBytes(manifest.tablesKey);
  if (digest(bytes) !== manifest.tablesSha256) throw new Error('BackupChecksumMismatch');
  const tables = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }));
  validateTables(tables);
  return { manifest, tables };
}

// The caller must supply a freshly fetched independent deletion ledger, never a
// snapshot's old ledger alone. All copies go to an empty isolated destination.
export async function restoreBackup({ backup, backupObjects, targetPool, targetObjects, latestLedger, apply = false, checkLedger = async () => latestLedger }) {
  if (!Array.isArray(latestLedger)) throw new Error('LatestDeletionLedgerRequired');
  const tables = filterTables(backup.tables, latestLedger), wanted = new Set();
  const byKey = new Map(backup.manifest.objects.map(row => [row.key, row]));
  async function read(key) {
    const row = byKey.get(key);
    if (!row) throw new Error('BackupObjectMissing');
    const bytes = await backupObjects.getBytes(row.backupKey);
    if (bytes.length !== row.size || digest(bytes) !== row.sha256) throw new Error('BackupChecksumMismatch');
    wanted.add(key);
    return bytes;
  }
  // Verify everything, including attachments, even during dry runs, before writing.
  for (const message of tables.messages) {
    const manifest = JSON.parse(await read(message.object_manifest_key)), prefix = `mail/${message.domain_id}/${message.message_id}/`;
    for (const key of [message.object_manifest_key, manifest.body, manifest.raw?.key, ...(manifest.producerRecord ? [manifest.producerRecord] : []), ...manifest.parts.map(part => part.key)]) {
      if (!key?.startsWith(prefix)) throw new Error('InvalidMessageManifest');
      await read(key);
    }
  }
  for (const draft of tables.drafts) {
    if (!draft.object_key.startsWith(`drafts/${draft.domain_id}/${draft.alias_id}/${draft.draft_id}/`)) throw new Error('InvalidDraftObjectKey');
    const content = JSON.parse(await read(draft.object_key));
    for (const file of content.attachments || []) {
      if (!file.key?.startsWith(`uploads/${draft.domain_id}/`)) throw new Error('InvalidDraftObjectKey');
      await read(file.key);
    }
  }
  const result = { messages: tables.messages.length, entries: tables.mailbox_entries.length, drafts: tables.drafts.length, objects: wanted.size, blocked: backup.tables.mailbox_entries.length - tables.mailbox_entries.length, applied: apply };
  if (!apply) return result;
  for (const table of Object.keys(COLUMNS)) if ((await targetPool.query(`SELECT 1 FROM mail.${table} LIMIT 1`)).rowCount) throw new Error('RecoveryDatabaseNotEmpty');
  if ((await targetObjects.versions('')).length) throw new Error('RecoveryBucketNotEmpty');
  const ledgerDigest = rows => digest(JSON.stringify([...rows].map(validLedger).sort((a, b) => entryIdentity(a).localeCompare(entryIdentity(b)))));
  const before = ledgerDigest(latestLedger);
  if (before !== ledgerDigest(await checkLedger())) throw new Error('DeletionLedgerChangedRerunInFreshDestination');
  for (const key of wanted) {
    const bytes = await read(key);
    await targetObjects.put(key, bytes);
    if (digest(await targetObjects.getBytes(key)) !== digest(bytes)) throw new Error('RestoredObjectChecksumMismatch');
  }
  for (const [table, columns] of Object.entries(COLUMNS)) {
    for (let start = 0; start < tables[table].length; start += 100) {
      const rows = tables[table].slice(start, start + 100), args = rows.flatMap(row => columns.map(name => row[name]));
      const values = rows.map((_, row) => `(${columns.map((_, col) => `$${row * columns.length + col + 1}`).join(',')})`).join(',');
      await targetPool.query(`INSERT INTO mail.${table}(${columns.join(',')}) VALUES ${values}`, args);
    }
  }
  if (before !== ledgerDigest(await checkLedger())) throw new Error('DeletionLedgerChangedRerunInFreshDestination');
  return result;
}

export async function cleanupBackups({ backupObjects, now = Date.now() }) {
  let removed = 0;
  for (const row of await backupObjects.versions('snapshots/')) {
    const match = /^snapshots\/(\d{13})-[a-f0-9-]+\//.exec(row.key);
    if (!match) throw new Error('UnexpectedBackupKey');
    if (now - Number(match[1]) >= RETENTION_MS) { await backupObjects.removeVersion(row.key, row.versionId); removed++; }
  }
  for (const row of await backupObjects.versions('snapshots/')) {
    const match = /^snapshots\/(\d{13})-/.exec(row.key);
    if (!match || now - Number(match[1]) >= RETENTION_MS) throw new Error('ExpiredBackupRemains');
  }
  return { removed };
}

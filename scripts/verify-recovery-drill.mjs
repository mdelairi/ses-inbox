// Cloud drill verification. Writes only to the tagged disposable target, never source mail.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { productionContext } from './production-recovery-context.mjs';
import { createObjectStore } from '../mail/maintenance-store.mjs';
import { captureTables, filterTables, loadBackup, restoreBackup, createBackup, cleanupBackups, COLUMNS, digest, validLedger } from '../mail/backup.mjs';
import { createMailbox } from '../mail/mailbox.mjs';
import { createDrafts } from '../mail/drafts.mjs';
import { createRepository } from '../mail/repository.mjs';
import { ingestNotification } from '../mail/ingest.mjs';
import { cleanupMail, RETENTION_MS, DAY } from '../mail/retention.mjs';
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';

const context = await productionContext({ recovery: true });
const drill = JSON.parse(await readFile(new URL('../.audit/recovery-drill-resources.json', import.meta.url)));
const { Stacks: [stack] } = context.aws(['cloudformation', 'describe-stacks', '--stack-name', drill.stack]);
if (stack.StackStatus !== 'CREATE_COMPLETE') throw new Error('DrillStackNotReady');
const output = Object.fromEntries(stack.Outputs.map(row => [row.OutputKey, row.OutputValue]));
if (output.Host === context.storage.DatabaseHost || [context.storage.MailBucket, context.recoveryStack.BackupBucket].includes(output.Bucket)) throw new Error('SourceDestinationCollision');
const cluster = context.aws(['dsql', 'get-cluster', '--identifier', output.Host.split('.')[0]]);
const tags = context.aws(['s3api', 'get-bucket-tagging', '--bucket', output.Bucket]).TagSet;
if (cluster.tags?.Project !== 'project-inbox-recovery' || !tags.some(row => row.Key === 'Project' && row.Value === 'project-inbox-recovery')) throw new Error('DrillTagsRequired');
const pool = new AuroraDSQLPool({ host: output.Host, user: 'admin', profile: context.config.profile, region: context.config.region, max: 2, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
const objects = createObjectStore({ bucket: output.Bucket, region: context.config.region, credentials: context.credentials });
const result = { verifiedOn: new Date().toISOString(), stack: drill.stack, sourceModified: false };
const canonical = (table, rows) => digest(rows.map(row => JSON.stringify(COLUMNS[table].map(name => row[name]))).sort().join('\n'));
// A namespace adapter permits several synthetic scenarios in this disposable bucket.
// The normal production recovery command always requires a completely empty bucket.
function namespace(prefix) {
  const store = {
    get: key => objects.get(prefix + key), getBytes: key => objects.getBytes(prefix + key), getRecoverable: key => objects.getRecoverable(prefix + key),
    put: (key, ...args) => objects.put(prefix + key, ...args), remove: key => objects.remove(prefix + key),
    listCurrent: async key => (await objects.listCurrent(prefix + key)).map(key => key.slice(prefix.length)),
    versions: async key => (await objects.versions(prefix + key)).map(row => ({ ...row, key: row.key.slice(prefix.length) })),
    removeVersion: (key, version) => objects.removeVersion(prefix + key, version),
    getRaw: (bucket, key) => { if (bucket !== output.Bucket) throw new Error('WrongDrillBucket'); return objects.getBytes(prefix + key); },
    async ledger() { const rows = []; for (const key of await store.listCurrent('tombstones/')) rows.push(validLedger(JSON.parse(await store.get(key)))); return rows; },
  }; return store;
}
// The target has no application roles or active traffic; bounded deletes affect only this drill.
async function clearTables() {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const keys = columns.filter(name => ['domain_id', 'alias_id', 'message_id', 'draft_id', 'attempt_id', 'receipt_key', 'rfc_hash', 'generation', 'field', 'section', 'position'].includes(name));
    for (;;) {
      const rows = (await pool.query(`SELECT ${keys.join(',')} FROM mail.${table} LIMIT 500`)).rows;
      if (!rows.length) break;
      const args = [], conditions = rows.map(row => '(' + keys.map(name => { args.push(row[name]); return `${name}=$${args.length}`; }).join(' AND ') + ')');
      await pool.query(`DELETE FROM mail.${table} WHERE ${conditions.join(' OR ')}`, args);
    }
  }
}
try {
  if (!process.argv.includes('--synthetic')) {
    const first = JSON.parse(await readFile(new URL('../.audit/recovery-first-invoke.json', import.meta.url)));
    const backup = await loadBackup({ backupObjects: context.backups, key: first.backup.key });
    const ledger = await context.objects.ledger(), expected = filterTables(backup.tables, ledger), actual = await captureTables(pool);
    for (const table of Object.keys(COLUMNS)) assert.equal(canonical(table, actual[table]), canonical(table, expected[table]), `Restored SQL mismatch: ${table}`);
    assert.equal((await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('inbox_mail','inbox_worker','inbox_maintenance')")).rowCount, 0, 'Runtime roles must not transfer');
    const mailbox = createMailbox({ pool, objects }); let messages = 0, files = 0;
    for (const alias of expected.aliases) {
      const entries = expected.mailbox_entries.filter(row => row.alias_id === alias.alias_id && row.domain_id === alias.domain_id);
      for (const thread of new Set(entries.map(row => row.thread_id))) {
        const conversation = await mailbox.readThread({ mailbox: alias.address, thread });
        for (const message of conversation) {
          assert.ok(entries.some(row => row.message_id === message.id)); messages++;
          for (const file of message.attachments) {
            if (message.quarantined) { await assert.rejects(mailbox.attachment({ mailbox: alias.address, id: message.id, part: file.id }), { status: 403 }); continue; }
            const part = await mailbox.attachment({ mailbox: alias.address, id: message.id, part: file.id }); await objects.getBytes(part.key); files++;
          }
        }
      }
    }
    result.actualRestore = { snapshot: first.backup.key, counts: Object.fromEntries(Object.entries(expected).map(([table, rows]) => [table, rows.length])), messagesReadAcrossAliases: messages, attachmentsRead: files, sqlDigestsMatched: true, runtimeRolesAbsent: true, objectsVerifiedByRestore: true };
    await writeFile(new URL('../.audit/recovery-cloud-drill-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } else {
    // Actual data has already been verified. Retire only the disposable clone's SQL;
    // its files remain private until the whole temporary bucket is removed.
    await clearTables();
    const source = namespace('synthetic-source/'), backups = namespace('synthetic-backups/'), restored = namespace('synthetic-restored/');
    const domain = randomUUID(), other = randomUUID(), info = randomUUID(), taylor = randomUUID(), outside = randomUUID();
    for (const [id, name] of [[domain, 'recovery.invalid'], [other, 'other-recovery.invalid']]) await pool.query('INSERT INTO mail.domains VALUES($1,$2,$3,1)', [id, name, 'Synthetic recovery drill']);
    for (const [d, a, address] of [[domain, info, 'info@recovery.invalid'], [domain, taylor, 'taylor@recovery.invalid'], [other, outside, 'info@other-recovery.invalid']]) await pool.query('INSERT INTO mail.aliases VALUES($1,$2,$3,$4,true,true,false,$5,1)', [d, a, address, address, '']);
    const repo = createRepository(pool), now = Date.now();
    async function deliver(recipients, suffix, spam = false) {
      const key = `incoming/${randomUUID()}`;
      const raw = await new MailComposer({ from: 'sender@example.invalid', to: recipients, messageId: `<${randomUUID()}@example.invalid>`, subject: `Synthetic recovery ${suffix}`, text: 'Synthetic recovery phrase searchable', html: '<p>Synthetic recovery <b>phrase searchable</b></p><img src="cid:drill-inline">', attachments: [{ filename: 'note.txt', content: 'synthetic attachment bytes' }, { filename: 'inline.png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), cid: 'drill-inline', contentType: 'image/png' }] }).compile().build();
      await source.put(key, raw);
      const n = { notificationType: 'Received', mail: { messageId: randomUUID(), timestamp: new Date(now).toISOString() }, receipt: { recipients, action: { type: 'S3', bucketName: output.Bucket, objectKey: key }, spamVerdict: { status: spam ? 'FAIL' : 'PASS' }, virusVerdict: { status: 'PASS' } } };
      return (await ingestNotification({ notification: n, repo, objects: source, bucket: output.Bucket, now: () => now })).results[0];
    }
    const shared = await deliver(['info@recovery.invalid', 'taylor@recovery.invalid'], 'shared');
    const kept = await deliver(['info@other-recovery.invalid'], 'retained Spam', true);
    const mailbox = createMailbox({ pool, objects: source }), drafts = createDrafts({ pool, objects: source, mailbox });
    const draftId = randomUUID(), upload = `uploads/${domain}/${randomUUID()}/${digest('draft bytes')}`;
    await source.put(upload, 'draft bytes');
    await drafts.save({ mailbox: 'info@recovery.invalid', id: draftId, revision: 0, draft: { to: 'unfinished@', subject: 'Synthetic draft', text: 'Typed unfinished draft', html: '<p>Typed unfinished draft</p>', attachments: [{ key: upload, name: 'draft.txt', type: 'text/plain', size: 11, sha256: digest('draft bytes') }] } });
    const saved = await createBackup({ pool, sourceObjects: source, backupObjects: backups, source: { bucket: output.Bucket, host: output.Host, synthetic: true }, now: () => now });
    const backup = await loadBackup({ backupObjects: backups, key: saved.key });
    await mailbox.setState({ mailbox: 'info@recovery.invalid', ids: [shared.messageId], folder: 'trash' });
    await mailbox.deleteForever({ mailbox: 'info@recovery.invalid', ids: [shared.messageId], now });
    const firstLedger = await source.ledger();
    assert.equal((await mailbox.readThread({ mailbox: 'taylor@recovery.invalid', thread: shared.threadId })).length, 1);
    const preview = await restoreBackup({ backup, backupObjects: backups, latestLedger: firstLedger });
    assert.equal(preview.blocked, 1); assert.equal(preview.entries, 2);
    await mailbox.setState({ mailbox: 'taylor@recovery.invalid', ids: [shared.messageId], folder: 'trash' });
    const remove = source.remove;
    source.remove = async key => { await remove(key); if (key.endsWith('manifest.json')) throw new Error('InjectedDrillPurgeFailure'); };
    await mailbox.deleteForever({ mailbox: 'taylor@recovery.invalid', ids: [shared.messageId], now });
    source.remove = remove;
    assert.equal((await pool.query('SELECT content_removed FROM mail.purge_jobs WHERE message_id=$1', [shared.messageId])).rows[0].content_removed, false);
    const retry = await cleanupMail({ pool, objects: source, now }); assert.equal(retry.purged, 1);
    const latestLedger = await source.ledger(); assert.equal(latestLedger.length, 2);
    const deadline = await cleanupMail({ pool, objects: source, now: now + RETENTION_MS + 1000 });
    assert.equal((await source.versions(`mail/${domain}/${shared.messageId}/`)).length, 0);
    assert.ok((await source.listCurrent(`mail/${other}/${kept.messageId}/`)).length, 'Current retained Spam must not expire');
    await clearTables();
    const partialRestore = await restoreBackup({ backup, backupObjects: backups, latestLedger: firstLedger, targetPool: pool, targetObjects: restored, apply: true });
    const readMailbox = createMailbox({ pool, objects: restored });
    assert.equal((await readMailbox.listThreads({ mailbox: 'info@recovery.invalid' })).threads.length, 0);
    const [message] = await readMailbox.readThread({ mailbox: 'taylor@recovery.invalid', thread: shared.threadId }); assert.match(message.html, /cid:drill-inline/);
    assert.equal(message.attachments.length, 2);
    assert.ok((await readMailbox.search({ mailbox: 'taylor@recovery.invalid', query: '"phrase searchable"' })).ids.includes(shared.messageId));
    assert.ok(!(await readMailbox.search({ mailbox: 'info@other-recovery.invalid', query: '"phrase searchable"' })).ids.includes(shared.messageId));
    const recoveredDraft = await createDrafts({ pool, objects: restored, mailbox: readMailbox }).get({ mailbox: 'info@recovery.invalid', id: draftId }); assert.equal(recoveredDraft.draft.to, 'unfinished@'); assert.equal(await restored.get(upload), 'draft bytes');
    await clearTables(); for (const row of await restored.versions('')) await restored.removeVersion(row.key, row.versionId);
    const finalRestore = await restoreBackup({ backup, backupObjects: backups, latestLedger, targetPool: pool, targetObjects: restored, apply: true });
    assert.equal(finalRestore.blocked, 2); assert.equal(finalRestore.messages, 1); assert.equal(finalRestore.entries, 1);
    assert.equal((await restored.listCurrent(`mail/${domain}/${shared.messageId}/`)).length, 0);
    await cleanupBackups({ backupObjects: backups, now: now + RETENTION_MS + 1000 }); assert.equal((await backups.versions('')).length, 0);
    const previous = JSON.parse(await readFile(new URL('../.audit/recovery-cloud-drill-result.json', import.meta.url)));
    previous.synthetic = { verifiedOn: new Date().toISOString(), deletionLedgerBlocksResurrection: true, sharedAliasRetained: true, lastReferencePurgeRetried: true, physicalVersionsRemovedAtDeadline: true, currentSpamRetained: true, richHtmlInlinePartsRestored: true, draftAndUploadRestored: true, searchAndDomainIsolation: true, partialRestore, finalRestore, retry, deadline };
    await writeFile(new URL('../.audit/recovery-cloud-drill-result.json', import.meta.url), JSON.stringify(previous, null, 2) + '\n');
    console.log(JSON.stringify(previous.synthetic));
  }
} finally { await pool.end(); await context.pool.end(); }

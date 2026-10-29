import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, loadBackup, restoreBackup, cleanupBackups, captureTables, COLUMNS, filterTables } from '../mail/backup.mjs';
import { cleanupMail, expiredVersions, recordDeletion, RETENTION_MS, DAY } from '../mail/retention.mjs';
import { preserveRaw } from '../mail/preserve-raw.mjs';
import { runMaintenanceStages } from '../mail/maintenance-stages.mjs';
import { createMailbox } from '../mail/mailbox.mjs';
import { postgresAvailable, startPostgres } from './helpers/postgres.mjs';
import { mailFixture } from './helpers/mail-fixture.mjs';
import { versionedObjects } from './helpers/versioned-mail-objects.mjs';

let db;
test.before(async () => { if (postgresAvailable) db = await startPostgres(); });
test.after(async () => { await db?.stop(); });
const skip = !postgresAvailable && 'PostgreSQL unavailable';
async function fixture() {
  const f = await mailFixture(db);
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const source = versionedObjects(() => clock), backups = versionedObjects(() => clock);
  // Deliver through the production pipeline first, then mirror its immutable objects.
  const [delivery] = await f.deliver(['info@example.com', 'taylor@example.com'], { text: 'Keep this full text.', attachments: [{ filename: 'a.txt', content: 'attachment bytes' }] });
  for (const [key, bytes] of f.stored) await source.put(key, bytes);
  return { ...f, source, backups, delivery, now: () => clock, advance: ms => clock += ms, mailbox: createMailbox({ pool: db.pool, objects: source }) };
}
const backupSource = { bucket: 'mail-bucket', host: 'source.invalid', accountId: 'test' };

test('restore uses the latest deletion ledger, preserves the other alias and verifies files', { skip }, async () => {
  const f = await fixture();
  const saved = await createBackup({ pool: db.pool, sourceObjects: f.source, backupObjects: f.backups, source: backupSource, now: f.now });
  const backup = await loadBackup({ backupObjects: f.backups, key: saved.key, now: f.now() });
  const tombstone = { domain_id: f.domains.example, alias_id: f.aliases.info, message_id: f.delivery.messageId, deleted_at: new Date(f.now()).toISOString() };
  const ledger = [tombstone];
  const preview = await restoreBackup({ backup, backupObjects: f.backups, latestLedger: ledger });
  assert.deepEqual([preview.messages, preview.entries, preview.blocked], [1, 1, 1]);
  const target = await startPostgres(), objects = versionedObjects(f.now);
  try {
    await restoreBackup({ backup, backupObjects: f.backups, latestLedger: ledger, targetPool: target.pool, targetObjects: objects, apply: true });
    const mailbox = createMailbox({ pool: target.pool, objects });
    assert.equal((await mailbox.listThreads({ mailbox: 'info@example.com' })).threads.length, 0);
    const [message] = await mailbox.readThread({ mailbox: 'taylor@example.com', thread: f.delivery.threadId });
    assert.match(message.text, /Keep this full text/);
    const attachment = await mailbox.attachment({ mailbox: 'taylor@example.com', id: message.id, part: 0 });
    assert.equal(await objects.get(attachment.key), 'attachment bytes');
    await assert.rejects(restoreBackup({ backup, backupObjects: f.backups, latestLedger: ledger, targetPool: target.pool, targetObjects: objects, apply: true }), /RecoveryDatabaseNotEmpty/);
  } finally { await target.stop(); }
  const both = [...ledger, { ...tombstone, alias_id: f.aliases.taylor }];
  const none = await restoreBackup({ backup, backupObjects: f.backups, latestLedger: both });
  assert.deepEqual([none.messages, none.entries, none.objects], [0, 0, 0]);
});

test('partial and corrupted backups cannot restore, and expiration removes every version', { skip }, async () => {
  const f = await fixture();
  const saved = await createBackup({ pool: db.pool, sourceObjects: f.source, backupObjects: f.backups, source: backupSource, now: f.now });
  const backup = await loadBackup({ backupObjects: f.backups, key: saved.key, now: f.now() });
  const file = backup.manifest.objects.find(row => row.key.endsWith('/parts/0'));
  await f.backups.put(file.backupKey, 'tampered');
  await assert.rejects(restoreBackup({ backup, backupObjects: f.backups, latestLedger: [] }), /BackupChecksumMismatch/);
  await assert.rejects(restoreBackup({ backup, backupObjects: f.backups }), /LatestDeletionLedgerRequired/);
  const original = f.backups.put;
  f.backups.put = async function(key, ...args) { if (key.endsWith('/manifest.json')) throw new Error('InjectedCommitFailure'); return original.call(this, key, ...args); };
  f.advance(1000);
  await assert.rejects(createBackup({ pool: db.pool, sourceObjects: f.source, backupObjects: f.backups, source: backupSource, now: f.now }), /InjectedCommitFailure/);
  assert.equal((await f.backups.listCurrent('snapshots/')).filter(key => key.endsWith('/manifest.json')).length, 1);
  f.advance(RETENTION_MS);
  await assert.rejects(loadBackup({ backupObjects: f.backups, key: saved.key, now: f.now() }), /BackupExpiredOrInvalid/);
  await cleanupBackups({ backupObjects: f.backups, now: f.now() });
  assert.deepEqual(await f.backups.versions('snapshots/'), []);
});

test('failed inline purge survives manifest loss, retries, and removes all versions by deadline', { skip }, async () => {
  const f = await fixture(), id = f.delivery.messageId, prefix = `mail/${f.domains.example}/${id}/`;
  for (const address of ['info@example.com', 'taylor@example.com']) await f.mailbox.setState({ mailbox: address, ids: [id], folder: 'trash' });
  await f.mailbox.deleteForever({ mailbox: 'info@example.com', ids: [id], now: f.now() });
  const original = f.source.remove;
  f.source.remove = async function(key) { await original.call(this, key); if (key.endsWith('/manifest.json')) throw new Error('InjectedPurgeFailure'); };
  await f.mailbox.deleteForever({ mailbox: 'taylor@example.com', ids: [id], now: f.now() });
  assert.equal((await db.pool.query('SELECT content_removed FROM mail.purge_jobs')).rows[0].content_removed, false);
  assert.equal((await f.source.listCurrent('tombstones/')).length, 2);
  f.source.remove = original;
  await cleanupMail({ pool: db.pool, objects: f.source, now: f.now() });
  assert.deepEqual(await f.source.listCurrent(prefix), []);
  assert.ok((await f.source.versions(prefix)).length);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.messages')).rows[0].n, 0);
  // No retired message appears in a fresh snapshot even while versions are recoverable.
  assert.equal((await captureTables(db.pool)).messages.length, 0);
  f.advance(RETENTION_MS);
  await cleanupMail({ pool: db.pool, objects: f.source, now: f.now() });
  assert.deepEqual(await f.source.versions(prefix), []);
  assert.equal((await db.pool.query('SELECT complete FROM mail.purge_jobs')).rows[0].complete, true);
});

test('raw migration verifies the durable copy and does not alter intake or mailbox state', { skip }, async () => {
  const f = await fixture(), key = `mail/${f.domains.example}/${f.delivery.messageId}/manifest.json`;
  const manifest = JSON.parse(await f.source.get(key)), intake = [...f.stored.keys()].find(key => key.startsWith('incoming/'));
  manifest.raw.key = intake;
  await f.source.put(key, JSON.stringify(manifest));
  const dry = await preserveRaw({ pool: db.pool, objects: f.source, bucket: 'mail-bucket' });
  assert.deepEqual([dry.needsCopy, dry.preserved], [1, 0]);
  assert.equal(JSON.parse(await f.source.get(key)).raw.key, intake);
  const actual = await preserveRaw({ pool: db.pool, objects: f.source, bucket: 'mail-bucket', apply: true });
  assert.equal(actual.preserved, 1);
  assert.equal(JSON.parse(await f.source.get(key)).raw.key, `mail/${f.domains.example}/${f.delivery.messageId}/raw.eml`);
  assert.equal(await f.source.get(`mail/${f.domains.example}/${f.delivery.messageId}/raw.eml`), await f.source.get(intake));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM mail.mailbox_entries')).rows[0].n, 2);
  assert.equal((await preserveRaw({ pool: db.pool, objects: f.source, bucket: 'mail-bucket', apply: true })).needsCopy, 0);
});

test('version retirement uses successor time, never the age of retained current content', () => {
  const now = Date.parse('2026-10-28T12:00:00Z'), old = new Date(now - 100 * DAY).toISOString(), recent = new Date(now - DAY).toISOString();
  const versions = [{ key: 'mail/live', versionId: 'current', isLatest: true, lastModified: old }, { key: 'mail/changed', versionId: 'new', isLatest: true, lastModified: recent }, { key: 'mail/changed', versionId: 'old', isLatest: false, lastModified: old }];
  assert.deepEqual(expiredVersions(versions, now), []);
  assert.deepEqual(expiredVersions(versions, now + 29 * DAY).map(row => row.versionId), ['old']);
});

test('an unavailable independent ledger fails deletion before it can be acknowledged', async () => {
  await assert.rejects(recordDeletion({ async put() { throw new Error('LedgerUnavailable'); } }, 'domain', 'alias', 'message', new Date().toISOString()), /LedgerUnavailable/);
});

test('preservation failure cannot skip independent retention cleanup and still fails the invocation', async () => {
  const attempted = [], failures = [];
  await assert.rejects(runMaintenanceStages({
    'backup-expiry': async () => { attempted.push('backup-expiry'); },
    'raw-preservation': async () => { attempted.push('raw-preservation'); throw new Error('InjectedCorruptManifest'); },
    'mail-cleanup': async () => { attempted.push('mail-cleanup'); },
  }, { onFailure: stage => failures.push(stage) }), /MaintenanceStageFailed/);
  assert.deepEqual(attempted, ['backup-expiry', 'raw-preservation', 'mail-cleanup']);
  assert.deepEqual(failures, ['raw-preservation']);
});

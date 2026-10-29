import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { createObjectStore } from './maintenance-store.mjs';
import { cleanupMail, recordDeletion } from './retention.mjs';
import { cleanupBackups, createBackup } from './backup.mjs';
import { preserveRaw } from './preserve-raw.mjs';
import { cleanupCaptureBuffer } from '../capture/retention.mjs';
import { runMaintenanceStages } from './maintenance-stages.mjs';

const { MAIL_BUCKET: bucket, BACKUP_BUCKET: backupBucket, MAIL_DATABASE_HOST: host, AWS_REGION: region } = process.env;
const pool = new AuroraDSQLPool({ host, user: 'inbox_maintenance', region, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, maxLifetimeSeconds: 300, ssl: { rejectUnauthorized: true } });
pool.on('error', () => {});
const captureObjects = process.env.CAPTURE_BUCKET ? createObjectStore({ bucket: process.env.CAPTURE_BUCKET, region }) : null;
const objects = createObjectStore({ bucket, region }), backups = createObjectStore({ bucket: backupBucket, region });
function metric(values) {
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'ProjectInbox/ProductionRecovery', Dimensions: [['Service']], Metrics: Object.keys(values).map(Name => ({ Name, Unit: 'None' })) }] }, Service: 'mail', ...values }));
}
export async function handler(_event, context) {
  const checkTime = () => { if (context.getRemainingTimeInMillis() < 45000) throw new Error('MaintenanceTimeBudgetExceeded'); };
  try {
    const completed = await runMaintenanceStages({
      'backup-expiry': () => cleanupBackups({ backupObjects: backups }),
      ...(captureObjects ? { 'capture-buffer-expiry': () => cleanupCaptureBuffer({ objects: captureObjects }) } : {}),
      'deletion-ledger': async () => {
        const { rows: ledger } = await pool.query('SELECT domain_id, alias_id, message_id, deleted_at::text AS deleted_at FROM mail.deletion_tombstones');
        for (const row of ledger) { checkTime(); await recordDeletion(objects, row.domain_id, row.alias_id, row.message_id, row.deleted_at); }
      },
      'raw-preservation': () => preserveRaw({ pool, objects, bucket, apply: true, checkTime }),
      'mail-cleanup': () => cleanupMail({ pool, objects }),
    }, { checkTime, onFailure: (stage, error) => console.error(JSON.stringify({ event: 'maintenance-stage-failed', stage, name: error.name, code: error.code })) });
    const { 'backup-expiry': expired, 'raw-preservation': raw, 'mail-cleanup': cleanup } = completed;
    checkTime();
    const complete = (await backups.listCurrent('snapshots/')).filter(key => /^snapshots\/\d{13}-[a-f0-9-]+\/manifest\.json$/.test(key));
    const newest = Math.max(0, ...complete.map(key => Number(key.split('/')[1].slice(0, 13))));
    let backup;
    if (Date.now() - newest >= 24 * 3600000) {
      backup = await createBackup({ pool, sourceObjects: objects, backupObjects: backups, source: { bucket, host, accountId: context.invokedFunctionArn.split(':')[4] }, checkTime });
    }
    metric({ BackupAgeHours: backup ? 0 : (Date.now() - newest) / 3600000 });
    // Counts and object keys only; no headers, body text or SQL error details.
    console.log(JSON.stringify({ event: 'maintenance-complete', raw, cleanup, expired, backup }));
    return { raw, cleanup, expired, backup };
  } catch (error) { console.error(JSON.stringify({ event: 'maintenance-failed', name: error.name })); throw new Error('ProductionMaintenanceFailed'); }
}

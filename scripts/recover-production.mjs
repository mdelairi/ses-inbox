// Dry-run by default. Restore only into an explicitly supplied empty DSQL cluster
// and empty private bucket tagged Project=project-inbox-recovery, never the source.
import { readFile } from 'node:fs/promises';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { productionContext } from './production-recovery-context.mjs';
import { createObjectStore } from '../mail/maintenance-store.mjs';
import { loadBackup, restoreBackup } from '../mail/backup.mjs';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const context = await productionContext({ recovery: true });
let targetPool;
try {
  if (!args.includes('--backup')) {
    for (const key of (await context.backups.listCurrent('snapshots/')).filter(key => key.endsWith('/manifest.json')).sort()) console.log(key);
  } else {
    const key = option('--backup'), backup = await loadBackup({ backupObjects: context.backups, key });
    if (backup.manifest.source.bucket !== context.storage.MailBucket || backup.manifest.source.host !== context.storage.DatabaseHost || backup.manifest.source.accountId !== context.config.accountId) throw new Error('WrongBackupSource');
    const latestLedger = await context.objects.ledger(), apply = args.includes('--apply');
    let targetObjects;
    if (apply) {
      const bucket = option('--target-bucket'), host = option('--target-host');
      if (!args.includes('--target-bucket') || !args.includes('--target-host') || bucket === context.storage.MailBucket || bucket === context.recoveryStack.BackupBucket || host === context.storage.DatabaseHost || !/^[a-z0-9]+\.dsql\.us-east-1\.on\.aws$/.test(host)) throw new Error('IsolatedDestinationRequired');
      const bucketTags = context.aws(['s3api', 'get-bucket-tagging', '--bucket', bucket]).TagSet;
      if (!bucketTags.some(row => row.Key === 'Project' && row.Value === 'project-inbox-recovery')) throw new Error('RecoveryBucketTagRequired');
      const cluster = context.aws(['dsql', 'get-cluster', '--identifier', host.split('.')[0]]);
      if (cluster.tags?.Project !== 'project-inbox-recovery') throw new Error('RecoveryClusterTagRequired');
      targetPool = new AuroraDSQLPool({ host, user: 'admin', profile: context.config.profile, region: context.config.region, max: 2, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
      targetObjects = createObjectStore({ bucket, region: context.config.region, credentials: context.credentials });
      if (args.includes('--initialize-schema')) {
        if ((await targetPool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='mail'")).rowCount) throw new Error('RecoverySchemaAlreadyExists');
        await targetPool.query('CREATE SCHEMA mail');
        const ddl = (await readFile(new URL('../mail/schema.sql', import.meta.url), 'utf8')).replace(/^--.*$/gm, '');
        for (const statement of ddl.split(';').map(text => text.trim()).filter(Boolean)) {
          const result = await targetPool.query(statement);
          const job = /^CREATE (UNIQUE )?INDEX ASYNC/.test(statement) && result.rows?.[0] && Object.values(result.rows[0])[0];
          if (job) for (let i = 0; ; i++) {
            const { rows: [state] } = await targetPool.query('SELECT status FROM sys.jobs WHERE job_id=$1', [job]);
            if (state?.status === 'completed') break;
            if (state?.status === 'failed' || i >= 300) throw new Error('RecoveryIndexBuildFailed');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }
    const result = await restoreBackup({ backup, backupObjects: context.backups, targetPool, targetObjects, latestLedger, apply, checkLedger: () => context.objects.ledger() });
    console.log(JSON.stringify({ ...result, isolatedOnly: true, promotionVerified: false }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await targetPool?.end(); await context.pool.end(); }

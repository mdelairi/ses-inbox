// Administrative CLI context, never bundled into a runtime.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { fromIni } from '@aws-sdk/credential-providers';
import { createObjectStore } from '../mail/maintenance-store.mjs';

export async function productionContext({ recovery = false } = {}) {
  const config = JSON.parse(await readFile(new URL('../production/config.json', import.meta.url)));
  const aws = args => JSON.parse(execFileSync('aws', [...args, '--profile', config.profile, '--region', config.region, '--output', 'json'], { encoding: 'utf8', timeout: 30000 }));
  if (aws(['sts', 'get-caller-identity']).Account !== config.accountId) throw new Error('WrongProductionAccount');
  const outputs = suffix => {
    const { Stacks: [stack] } = aws(['cloudformation', 'describe-stacks', '--stack-name', `${config.stackPrefix}-${suffix}`]);
    if (!/_COMPLETE$/.test(stack.StackStatus) || /ROLLBACK|DELETE/.test(stack.StackStatus)) throw new Error('StackNotReady');
    return Object.fromEntries(stack.Outputs.map(row => [row.OutputKey, row.OutputValue]));
  };
  const storage = outputs('storage'), recoveryStack = recovery ? outputs('recovery') : {};
  const credentials = fromIni({ profile: config.profile });
  const pool = new AuroraDSQLPool({ host: storage.DatabaseHost, user: 'admin', profile: config.profile, region: config.region, max: 2, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
  const objects = createObjectStore({ bucket: storage.MailBucket, region: config.region, credentials });
  const backups = recovery ? createObjectStore({ bucket: recoveryStack.BackupBucket, region: config.region, credentials }) : undefined;
  return { config, aws, storage, recoveryStack, credentials, pool, objects, backups };
}

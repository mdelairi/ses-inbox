// Explicit administrative setup for the production mail database; never bundled into a Lambda.
// Idempotent: tables and indexes use IF NOT EXISTS, seeded aliases are never overwritten.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AuroraDSQLClient } from '@aws/aurora-dsql-node-postgres-connector';
import pg from 'pg';
const config = JSON.parse(await readFile(new URL('../production/config.json', import.meta.url)));
const aws = args => JSON.parse(execFileSync('aws', [...args, '--profile', config.profile, '--region', config.region, '--output', 'json'], { encoding: 'utf8' }));
if (aws(['sts', 'get-caller-identity']).Account !== config.accountId) throw new Error('Wrong production account');
const outputs = stack => { const [detail] = aws(['cloudformation', 'describe-stacks', '--stack-name', `${config.stackPrefix}-${stack}`]).Stacks; if (!/_COMPLETE$/.test(detail.StackStatus) || /ROLLBACK|DELETE/.test(detail.StackStatus)) throw new Error(`${stack} stack is not ready`); return Object.fromEntries(detail.Outputs.map(item => [item.OutputKey, item.OutputValue])); };
const storage = outputs('storage'), app = outputs('app');
if (!/^[a-z0-9]+\.dsql\.us-east-1\.on\.aws$/.test(storage.DatabaseHost)) throw new Error('Invalid database endpoint');
for (const arn of [app.AppRoleArn, app.WorkerRoleArn]) if (!arn.startsWith(`arn:aws:iam::${config.accountId}:role/`)) throw new Error('Invalid runtime role');

// Each role gets only what its code paths use (mail/repository, mailbox, drafts, send, ingest).
const GRANTS = {
  // DELETE on content tables is for purging a message after its last alias deletes it.
  inbox_mail: { role: app.AppRoleArn, tables: { domains: 'SELECT', aliases: 'SELECT', messages: 'SELECT, INSERT, UPDATE, DELETE', message_ids: 'SELECT, INSERT, DELETE', mailbox_entries: 'SELECT, INSERT, UPDATE, DELETE',
    search_positions: 'SELECT, INSERT, DELETE', drafts: 'SELECT, INSERT, UPDATE, DELETE', deletion_tombstones: 'SELECT, INSERT', ingestion_receipts: 'SELECT', purge_jobs: 'SELECT, INSERT, UPDATE', send_attempts: 'SELECT, INSERT, UPDATE, DELETE',
    forward_rules: 'SELECT, INSERT, DELETE', forward_attempts: 'SELECT', push_subscriptions: 'SELECT, INSERT, UPDATE, DELETE' } },
  inbox_worker: { role: app.WorkerRoleArn, tables: { domains: 'SELECT', aliases: 'SELECT', messages: 'SELECT, INSERT, UPDATE', message_ids: 'SELECT, INSERT', mailbox_entries: 'SELECT, INSERT',
    search_positions: 'SELECT, INSERT', purge_jobs: 'SELECT', deletion_tombstones: 'SELECT', ingestion_receipts: 'SELECT, INSERT, UPDATE', send_attempts: 'SELECT, UPDATE',
    forward_rules: 'SELECT', forward_attempts: 'SELECT, INSERT, UPDATE', push_subscriptions: 'SELECT, UPDATE, DELETE' } },
};

if (process.argv.includes('--recovery')) {
  const recovery = outputs('recovery');
  if (!recovery.MaintenanceRoleArn.startsWith(`arn:aws:iam::${config.accountId}:role/`)) throw new Error('Invalid maintenance role');
  GRANTS.inbox_maintenance = { role: recovery.MaintenanceRoleArn, tables: Object.fromEntries(['domains', 'aliases', 'messages', 'message_ids', 'mailbox_entries', 'search_positions', 'drafts', 'deletion_tombstones', 'ingestion_receipts', 'send_attempts', 'purge_jobs'].map(table => [table, ({ messages: 'SELECT, DELETE', message_ids: 'SELECT, DELETE', search_positions: 'SELECT, DELETE', send_attempts: 'SELECT, DELETE', purge_jobs: 'SELECT, INSERT, UPDATE' })[table] || 'SELECT'])) };
}

if (process.argv.includes('--capture')) {
  const capture = outputs('capture');
  if (!capture.CaptureWorkerRoleArn.startsWith(`arn:aws:iam::${config.accountId}:role/`)) throw new Error('Invalid capture role');
  GRANTS.inbox_capture = { role: capture.CaptureWorkerRoleArn, tables: { domains: 'SELECT', aliases: 'SELECT, INSERT', messages: 'SELECT, INSERT, UPDATE', message_ids: 'SELECT, INSERT', mailbox_entries: 'SELECT, INSERT', search_positions: 'SELECT, INSERT', deletion_tombstones: 'SELECT', ingestion_receipts: 'SELECT, INSERT, UPDATE', send_attempts: 'SELECT, INSERT, UPDATE', purge_jobs: 'SELECT' } };
}

const client = new AuroraDSQLClient({ host: storage.DatabaseHost, user: 'admin', profile: config.profile, region: config.region, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS mail');
  const ddl = (await readFile(new URL('../mail/schema.sql', import.meta.url), 'utf8')).replace(/^--.*$/gm, '');
  for (const statement of ddl.split(';').map(text => text.trim()).filter(Boolean)) {
    const result = await client.query(statement);
    const job = /^CREATE (UNIQUE )?INDEX ASYNC/.test(statement) && result.rows?.[0] && Object.values(result.rows[0])[0];
    if (job) {
      for (let i = 0; ; i++) {
        const { rows: [state] } = await client.query('SELECT status FROM sys.jobs WHERE job_id = $1', [job]);
        if (state?.status === 'completed') break;
        if (state?.status === 'failed' || i >= 300) throw new Error(`Index build did not complete: ${statement.split('(')[0]}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    console.log('ok', statement.split('(')[0].replace(/\s+/g, ' ').trim());
  }
  for (const [name, { role, tables }] of Object.entries(GRANTS)) {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount) await client.query(`CREATE ROLE ${name} WITH LOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA mail TO ${name}`);
    for (const [table, privileges] of Object.entries(tables)) await client.query(`GRANT ${privileges} ON mail.${table} TO ${name}`);
    await client.query(`AWS IAM GRANT ${name} TO ${pg.escapeLiteral(role)}`);
  }
  for (const domain of config.domains) {
    let { rows: [row] } = await client.query('SELECT domain_id FROM mail.domains WHERE name=$1', [domain.name]);
    if (!row) { row = { domain_id: randomUUID() }; await client.query('INSERT INTO mail.domains(domain_id,name,label,revision) VALUES($1,$2,$3,1)', [row.domain_id, domain.name, domain.label]); console.log('seeded', domain.name); }
    for (const alias of domain.aliases) {
      if ((await client.query('SELECT 1 FROM mail.aliases WHERE address=$1', [alias.address])).rowCount) continue;
      await client.query('INSERT INTO mail.aliases(domain_id,alias_id,address,display_name,receive_enabled,send_enabled,is_default,signature,revision) VALUES($1,$2,$3,$4,true,true,$5,$6,1)', [row.domain_id, randomUUID(), alias.address, alias.name, alias.default, alias.signature]);
      console.log('seeded', alias.address);
    }
  }
  console.log('Production mail database ready; runtime roles inbox_mail and inbox_worker mapped.');
} finally { await client.end(); }

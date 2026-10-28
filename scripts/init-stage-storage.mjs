// Explicit administrative setup, never bundled into the Lambda.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../stage/package.json', import.meta.url));
const { AuroraDSQLClient } = require('@aws/aurora-dsql-node-postgres-connector');
const { escapeLiteral } = require('pg');
const config = JSON.parse(await readFile(new URL('../stage/config.json', import.meta.url)));
const aws = args => JSON.parse(execFileSync('aws', [...args, '--profile', config.profile, '--region', config.region, '--output', 'json'], { encoding: 'utf8' }));
if (aws(['sts', 'get-caller-identity']).Account !== config.accountId) throw new Error('Wrong staging account');
const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', `${config.stackPrefix}-storage`]).Stacks[0];
if (stack.StackStatus !== 'CREATE_COMPLETE' && stack.StackStatus !== 'UPDATE_COMPLETE') throw new Error('Storage stack is not ready');
const outputs = Object.fromEntries(stack.Outputs.map(output => [output.OutputKey, output.OutputValue]));
if (!/^[a-z0-9]+\.dsql\.us-east-1\.on\.aws$/.test(outputs.DatabaseHost)) throw new Error('Invalid storage endpoint');
const resource = aws(['cloudformation', 'describe-stack-resource', '--stack-name', `${config.stackPrefix}-app`, '--logical-resource-id', 'AppRole']).StackResourceDetail;
const role = aws(['iam', 'get-role', '--role-name', resource.PhysicalResourceId]).Role.Arn;
if (!role.startsWith(`arn:aws:iam::${config.accountId}:role/`)) throw new Error('Invalid runtime role');
const client = new AuroraDSQLClient({ host: outputs.DatabaseHost, user: 'admin', profile: config.profile, region: config.region, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS inbox_stage');
  if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', ['inbox_stage'])).rowCount) await client.query('CREATE ROLE inbox_stage WITH LOGIN');
  await client.query('CREATE TABLE IF NOT EXISTS inbox_stage.workspace(owner_key VARCHAR(64) PRIMARY KEY, revision INTEGER NOT NULL, object_key TEXT NOT NULL, digest VARCHAR(64) NOT NULL, write_id VARCHAR(80) NOT NULL)');
  for (const [name, type] of [['maintenance_token', 'VARCHAR(64)'], ['maintenance_started_at', 'TIMESTAMP']]) {
    const exists = await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', ['inbox_stage', 'workspace', name]);
    if (!exists.rowCount) await client.query(`ALTER TABLE inbox_stage.workspace ADD COLUMN ${name} ${type}`);
  }
  await client.query('CREATE TABLE IF NOT EXISTS inbox_stage.tombstones(owner_key VARCHAR(64),entry_key VARCHAR(64),kind VARCHAR(16) NOT NULL,domain VARCHAR(253) NOT NULL,item_id VARCHAR(100) NOT NULL,mailbox VARCHAR(254) NOT NULL,deleted_at TIMESTAMP NOT NULL,PRIMARY KEY(owner_key,entry_key))');
  await client.query('CREATE TABLE IF NOT EXISTS inbox_stage.retired_objects(owner_key VARCHAR(64),object_key_hash VARCHAR(64),object_key TEXT NOT NULL,kind VARCHAR(16) NOT NULL,retired_at TIMESTAMP NOT NULL,purge_after TIMESTAMP NOT NULL,content_sha VARCHAR(64),PRIMARY KEY(owner_key,object_key_hash))');
  await client.query(`AWS IAM GRANT inbox_stage TO ${escapeLiteral(role)}`);
  await client.query('GRANT USAGE ON SCHEMA inbox_stage TO inbox_stage');
  await client.query('GRANT SELECT, INSERT, UPDATE ON inbox_stage.workspace TO inbox_stage');
  await client.query('GRANT SELECT, INSERT ON inbox_stage.tombstones TO inbox_stage');
  await client.query('GRANT SELECT, INSERT ON inbox_stage.retired_objects TO inbox_stage');
  if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', ['inbox_maintenance'])).rowCount) await client.query('CREATE ROLE inbox_maintenance WITH LOGIN');
  await client.query('GRANT USAGE ON SCHEMA inbox_stage TO inbox_maintenance');
  await client.query('GRANT SELECT, UPDATE ON inbox_stage.workspace TO inbox_maintenance');
  await client.query('GRANT SELECT ON inbox_stage.tombstones TO inbox_maintenance');
  await client.query('GRANT SELECT, INSERT, DELETE ON inbox_stage.retired_objects TO inbox_maintenance');
  const maintenance = aws(['cloudformation', 'describe-stack-resource', '--stack-name', `${config.stackPrefix}-app`, '--logical-resource-id', 'MaintenanceRole']).StackResourceDetail;
  const maintenanceRole = aws(['iam', 'get-role', '--role-name', maintenance.PhysicalResourceId]).Role.Arn;
  await client.query(`AWS IAM GRANT inbox_maintenance TO ${escapeLiteral(maintenanceRole)}`);
  // The owner uses this scoped database role for explicit recovery tools, not admin.
  const actor = aws(['sts', 'get-caller-identity']).Arn;
  const actorRole = actor.match(/^arn:aws:sts::[0-9]+:assumed-role\/([^/]+)\//)?.[1];
  if (!actorRole) throw new Error('Recovery operator must use the existing staging role');
  const actorArn = aws(['iam', 'get-role', '--role-name', actorRole]).Role.Arn;
  // DSQL matches the session's assumed-role ARN, which omits IAM paths such as
  // SSO's /aws-reserved/sso.amazonaws.com/; a mapping with the path never matches.
  const sessionArn = `arn:aws:iam::${config.accountId}:role/${actorRole}`;
  const mapped = (await client.query('SELECT arn FROM sys.iam_pg_role_mappings WHERE pg_role_name=$1', ['inbox_maintenance'])).rows.map(row => row.arn);
  if (actorArn !== sessionArn && mapped.includes(actorArn)) await client.query(`AWS IAM REVOKE inbox_maintenance FROM ${escapeLiteral(actorArn)}`);
  if (!mapped.includes(sessionArn)) await client.query(`AWS IAM GRANT inbox_maintenance TO ${escapeLiteral(sessionArn)}`);
  console.log('Initialized isolated sample workspace schema and scoped runtime mapping.');
  console.log(JSON.stringify(outputs));
} finally { await client.end(); }

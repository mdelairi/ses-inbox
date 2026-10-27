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
  await client.query(`AWS IAM GRANT inbox_stage TO ${escapeLiteral(role)}`);
  await client.query('GRANT USAGE ON SCHEMA inbox_stage TO inbox_stage');
  await client.query('GRANT SELECT, INSERT, UPDATE ON inbox_stage.workspace TO inbox_stage');
  console.log('Initialized isolated sample workspace schema and scoped runtime mapping.');
  console.log(JSON.stringify(outputs));
} finally { await client.end(); }

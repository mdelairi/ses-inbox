// Delete only the tagged disposable resources created by this approved drill.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-providers';
import { createObjectStore } from '../mail/maintenance-store.mjs';
const config = JSON.parse(await readFile(new URL('../production/config.json', import.meta.url)));
const drill = JSON.parse(await readFile(new URL('../.audit/recovery-drill-resources.json', import.meta.url)));
const proof = JSON.parse(await readFile(new URL('../.audit/recovery-cloud-drill-result.json', import.meta.url)));
if (!/^project-inbox-recovery-drill-\d+$/.test(drill.stack) || !drill.ephemeral || !proof.actualRestore?.sqlDigestsMatched || !proof.synthetic?.physicalVersionsRemovedAtDeadline) throw new Error('CompletedDrillRequired');
const aws = args => { const value = execFileSync('aws', [...args, '--profile', config.profile, '--region', config.region, '--output', 'json'], { encoding: 'utf8', timeout: 30000 }); return value.trim() ? JSON.parse(value) : {}; };
if (aws(['sts', 'get-caller-identity']).Account !== config.accountId) throw new Error('WrongProductionAccount');
const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', drill.stack]).Stacks[0];
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('DrillStackNotReadyForCleanup');
const output = Object.fromEntries(stack.Outputs.map(row => [row.OutputKey, row.OutputValue]));
const source = JSON.parse(await readFile(new URL('../production/deployment.json', import.meta.url)));
if (output.Bucket === source.mailBucket || output.Host.split('.')[0] === source.mailDatabaseId || !output.Bucket.startsWith(drill.stack + '-')) throw new Error('SourceDestinationCollision');
const cluster = aws(['dsql', 'get-cluster', '--identifier', output.Host.split('.')[0]]);
const tags = aws(['s3api', 'get-bucket-tagging', '--bucket', output.Bucket]).TagSet;
if (cluster.tags?.Project !== 'project-inbox-recovery' || cluster.tags?.Ephemeral !== 'true' || !['Project', 'Environment', 'Ephemeral'].every(key => tags.some(row => row.Key === key && row.Value === ({ Project: 'project-inbox-recovery', Environment: 'recovery-drill', Ephemeral: 'true' })[key]))) throw new Error('DisposableTagsRequired');
const objects = createObjectStore({ bucket: output.Bucket, region: config.region, credentials: fromIni({ profile: config.profile }) });
const versions = await objects.versions('');
console.log(JSON.stringify({ stack: drill.stack, bucket: output.Bucket, cluster: output.Host.split('.')[0], versions: versions.length, apply: process.argv.includes('--apply') }));
if (process.argv.includes('--apply')) {
  for (const row of versions) await objects.removeVersion(row.key, row.versionId);
  if ((await objects.versions('')).length) throw new Error('DrillVersionsRemain');
  aws(['cloudformation', 'delete-stack', '--stack-name', drill.stack]);
  drill.cleanupStartedOn = new Date().toISOString(); drill.versionsDeleted = versions.length;
  await writeFile(new URL('../.audit/recovery-drill-resources.json', import.meta.url), JSON.stringify(drill, null, 2) + '\n');
  console.log('Temporary drill bucket emptied; ephemeral stack deletion started.');
}

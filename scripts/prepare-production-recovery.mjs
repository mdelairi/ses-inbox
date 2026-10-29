// Uploads a content-addressed release and creates review-only change sets. Never executes them.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--aws')) throw new Error('Use --aws to upload the release and create unexecuted change sets');
const root = new URL('../', import.meta.url), config = JSON.parse(await readFile(new URL('production/config.json', root)));
const release = JSON.parse(await readFile(new URL('build/production/release.json', root)));
const aws = args => JSON.parse(execFileSync('aws', [...args, '--profile', config.profile, '--region', config.region, '--output', 'json'], { encoding: 'utf8', timeout: 30000 }));
if (aws(['sts', 'get-caller-identity']).Account !== config.accountId) throw new Error('WrongProductionAccount');
const stack = suffix => aws(['cloudformation', 'describe-stacks', '--stack-name', `${config.stackPrefix}-${suffix}`]).Stacks[0];
const outputs = value => Object.fromEntries(value.Outputs.map(row => [row.OutputKey, row.OutputValue]));
const app = stack('app'), storage = outputs(stack('storage')), artifacts = outputs(stack('artifacts'));
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(app.StackStatus)) throw new Error('AppStackNotReady');
const alarm = aws(['cloudformation', 'describe-stack-resource', '--stack-name', app.StackName, '--logical-resource-id', 'Alarms']).StackResourceDetail.PhysicalResourceId;
execFileSync('aws', ['s3', 'cp', fileURLToPath(new URL('build/production/lambda.zip', root)), `s3://${artifacts.ArtifactBucket}/${release.artifactKey}`, '--profile', config.profile, '--region', config.region, '--only-show-errors'], { stdio: 'inherit', timeout: 60000 });
const appParameters = app.Parameters.map(row => row.ParameterKey === 'ArtifactKey' ? { ParameterKey: row.ParameterKey, ParameterValue: release.artifactKey } : { ParameterKey: row.ParameterKey, UsePreviousValue: true });
const recoveryValues = { Environment: 'production', ArtifactBucket: artifacts.ArtifactBucket, ArtifactKey: release.artifactKey, MailBucket: storage.MailBucket, MailDatabaseHost: storage.DatabaseHost, MailDatabaseArn: storage.DatabaseArn, AlarmTopicArn: alarm, MaintenanceState: 'DISABLED' };
let existingRecovery;
try { existingRecovery = stack('recovery'); } catch (error) { if (!String(error.stderr).includes('does not exist')) throw error; }
if (existingRecovery && !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(existingRecovery.StackStatus)) throw new Error('RecoveryStackNotReady');
const recoveryParameters = existingRecovery ? existingRecovery.Parameters.map(row => row.ParameterKey === 'ArtifactKey' ? { ParameterKey: row.ParameterKey, ParameterValue: release.artifactKey } : { ParameterKey: row.ParameterKey, UsePreviousValue: true }) : Object.entries(recoveryValues).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
const stamp = Date.now(), results = { preparedOn: new Date().toISOString(), release, executed: false, changeSets: {} };
for (const [suffix, type, template, parameters] of [['app', 'UPDATE', 'application', appParameters], ['recovery', existingRecovery ? 'UPDATE' : 'CREATE', 'recovery', recoveryParameters]]) {
  const path = new URL(`.audit/recovery-${suffix}-parameters.json`, root);
  await writeFile(path, JSON.stringify(parameters, null, 2) + '\n');
  const name = `recovery-review-${stamp}`;
  const { Id } = aws(['cloudformation', 'create-change-set', '--stack-name', `${config.stackPrefix}-${suffix}`, '--change-set-name', name, '--change-set-type', type, '--template-body', `file://${fileURLToPath(new URL(`build/production/templates/${template}.json`, root))}`, '--parameters', `file://${fileURLToPath(path)}`, '--capabilities', 'CAPABILITY_IAM']);
  let detail;
  for (let i = 0; ; i++) {
    detail = aws(['cloudformation', 'describe-change-set', '--change-set-name', Id]);
    if (['CREATE_COMPLETE', 'FAILED'].includes(detail.Status)) break;
    if (i >= 60) throw new Error('ChangeSetStillPreparing');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const events = aws(['cloudformation', 'describe-events', '--change-set-name', Id]);
  await writeFile(new URL(`.audit/recovery-${suffix}-validation.json`, root), JSON.stringify(events, null, 2) + '\n');
  const validation = (events.OperationEvents || []).filter(row => row.EventType === 'VALIDATION_ERROR');
  results.changeSets[suffix] = { id: Id, status: detail.Status, reason: detail.StatusReason, validation, changes: detail.Changes.map(row => ({ action: row.ResourceChange.Action, resource: row.ResourceChange.LogicalResourceId, type: row.ResourceChange.ResourceType, replacement: row.ResourceChange.Replacement })) };
  await writeFile(new URL('.audit/recovery-rollout-plan.json', root), JSON.stringify(results, null, 2) + '\n');
  if (detail.Status !== 'CREATE_COMPLETE' || validation.some(row => row.ValidationFailureMode === 'FAIL' && row.ValidationStatus === 'FAILED')) throw new Error('RecoveryPreflightFailed');
}
console.log(JSON.stringify(results.changeSets, null, 2));
console.log(existingRecovery ? 'Both update change sets are unexecuted; current scheduling is preserved.' : 'Both change sets are unexecuted. The new recovery stack is REVIEW_IN_PROGRESS; its schedule defaults DISABLED.');

// Execute the already authorized, narrowly scoped recovery activation/cadence change.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const suffix = process.argv.includes('--hourly') ? 'hourly' : 'scheduled-canary';
const change = JSON.parse(await readFile(`.audit/recovery-${suffix}-change-set.json`));
const aws = args => { const text = execFileSync('aws', [...args, '--profile', 'example-production', '--region', 'us-east-1', '--output', 'json'], { encoding: 'utf8', timeout: 30000 }); return text.trim() ? JSON.parse(text) : {}; };
if (aws(['sts', 'get-caller-identity']).Account !== '111111111111') throw new Error('WrongProductionAccount');
let detail;
for (let i = 0; ; i++) {
  detail = aws(['cloudformation', 'describe-change-set', '--change-set-name', change.Id]);
  if (['CREATE_COMPLETE', 'FAILED'].includes(detail.Status)) break;
  if (i >= 60) throw new Error('ChangeSetStillPreparing');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (detail.Status !== 'CREATE_COMPLETE' || detail.ExecutionStatus !== 'AVAILABLE') throw new Error('ChangeSetNotAvailable');
const events = aws(['cloudformation', 'describe-events', '--change-set-name', change.Id]);
const findings = (events.OperationEvents || []).filter(row => row.EventType === 'VALIDATION_ERROR');
if (findings.length) throw new Error('ScheduleValidationFindingsRequireReview');
const changes = detail.Changes.map(row => row.ResourceChange);
for (const row of changes) {
  if (!['Modify', 'Add'].includes(row.Action) || !['Maintenance', 'Schedule', 'SchedulePermission', 'HeartbeatAlarm', 'BackupAgeAlarm', 'FailureAlarm', 'RecoveryDLQAlarm'].includes(row.LogicalResourceId)) throw new Error('UnexpectedScheduleChange');
}
await writeFile(`.audit/recovery-${suffix}-validation.json`, JSON.stringify({ events, changes }, null, 2) + '\n');
console.log(JSON.stringify(changes.map(row => ({ action: row.Action, resource: row.LogicalResourceId, replacement: row.Replacement }))));
aws(['cloudformation', 'execute-change-set', '--change-set-name', change.Id]);
console.log(`Approved ${suffix} update started.`);

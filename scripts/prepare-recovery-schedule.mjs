// Approved activation: a brief scheduled canary, then the normal hourly rule.
// Creates an unexecuted change set; execution follows cloud-drill validation.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { accounts } from '../infra/accounts.mjs';
const hourly = process.argv.includes('--hourly');
const artifactIndex = process.argv.indexOf('--artifact-key'), artifactKey = artifactIndex < 0 ? undefined : process.argv[artifactIndex + 1];
if (artifactKey && !/^releases\/[a-f0-9]{64}\/lambda\.zip$/.test(artifactKey)) throw new Error('InvalidArtifactKey');
const aws = args => { const text = execFileSync('aws', [...args, '--profile', accounts.productionProfile, '--region', accounts.region, '--output', 'json'], { encoding: 'utf8', timeout: 30000 }); return text.trim() ? JSON.parse(text) : {}; };
if (aws(['sts', 'get-caller-identity']).Account !== accounts.production) throw new Error('WrongProductionAccount');
const proof = JSON.parse(await readFile('.audit/recovery-cloud-drill-result.json'));
if (!proof.actualRestore?.sqlDigestsMatched || !proof.synthetic?.deletionLedgerBlocksResurrection || !proof.synthetic?.physicalVersionsRemovedAtDeadline) throw new Error('CloudDrillRequired');
const template = JSON.parse(await readFile('build/production/templates/recovery.json'));
if (!hourly) template.Resources.Schedule.Properties.ScheduleExpression = 'rate(1 minute)';
const suffix = hourly ? 'hourly' : 'scheduled-canary';
const path = `.audit/recovery-${suffix}-template.json`;
await writeFile(path, JSON.stringify(template, null, 2) + '\n');
const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', 'project-inbox-prod-recovery']).Stacks[0];
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('RecoveryStackNotReady');
const parameters = stack.Parameters.map(row => row.ParameterKey === 'ArtifactKey' && artifactKey ? { ParameterKey: row.ParameterKey, ParameterValue: artifactKey } : row.ParameterKey === 'MaintenanceState' ? { ParameterKey: row.ParameterKey, ParameterValue: 'ENABLED' } : { ParameterKey: row.ParameterKey, UsePreviousValue: true });
const paramPath = `.audit/recovery-${suffix}-parameters.json`;
await writeFile(paramPath, JSON.stringify(parameters, null, 2) + '\n');
const result = aws(['cloudformation', 'create-change-set', '--stack-name', stack.StackName, '--change-set-name', `recovery-${suffix}-${Date.now()}`, '--change-set-type', 'UPDATE', '--template-body', `file://${path}`, '--parameters', `file://${paramPath}`, '--capabilities', 'CAPABILITY_IAM']);
await writeFile(`.audit/recovery-${suffix}-change-set.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

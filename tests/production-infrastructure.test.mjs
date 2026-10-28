import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTemplate, artifactTemplate, certificateTemplate, receivingTemplate, storageTemplate, RECEIPT_RULE_SET } from '../infra/production.mjs';

const all = () => [artifactTemplate(), certificateTemplate(), storageTemplate(), applicationTemplate(), receivingTemplate()];
const statements = role => role.Properties.Policies.flatMap(policy => policy.PolicyDocument.Statement);

test('templates fit inline limits, every reference resolves, and data is retained', () => {
  for (const template of all()) {
    assert.ok(Buffer.byteLength(JSON.stringify(template, null, 2)) < 51200);
    const names = new Set([...Object.keys(template.Resources), ...Object.keys(template.Parameters), 'AWS::StackName', 'AWS::Partition', 'AWS::AccountId', 'AWS::Region', 'AWS::NoValue']);
    (function inspect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.Ref) assert.ok(names.has(value.Ref), `Missing Ref ${value.Ref}`);
      if (value['Fn::GetAtt']) assert.ok(template.Resources[value['Fn::GetAtt'][0]], `Missing GetAtt ${value['Fn::GetAtt'][0]}`);
      if (value['Fn::Sub']) for (const match of value['Fn::Sub'].matchAll(/\$\{([^}]+)\}/g)) assert.ok(names.has(match[1].split('.')[0]), `Missing Sub ${match[1]}`);
      Object.values(value).forEach(inspect);
    })(template);
  }
  const storage = storageTemplate().Resources, app = applicationTemplate().Resources;
  for (const resource of [storage.Mail, storage.Database, storage.DeadLetters, app.Sessions, certificateTemplate().Resources.Certificate]) assert.equal(resource.DeletionPolicy, 'Retain');
  assert.equal(storage.Database.Properties.DeletionProtectionEnabled, true);
  assert.equal(app.Sessions.Properties.DeletionProtectionEnabled, true);
});
test('SES may only write incoming/ from this inbox\'s rules; topics and queue accept only SES and SNS', () => {
  const storage = storageTemplate().Resources;
  const [tls, ses] = storage.MailPolicy.Properties.PolicyDocument.Statement;
  assert.deepEqual(tls.Condition, { Bool: { 'aws:SecureTransport': false } });
  assert.deepEqual(ses.Action, 's3:PutObject'); assert.match(ses.Resource['Fn::Sub'], /\/incoming\/\*$/);
  assert.match(ses.Condition.ArnLike['AWS:SourceArn']['Fn::Sub'], new RegExp(`receipt-rule-set/${RECEIPT_RULE_SET}:receipt-rule/project-inbox-\\*$`));
  assert.ok(Object.values(storage.MailPolicy.Properties.PolicyDocument.Statement).every(statement => statement.Effect === 'Deny' || statement.Principal.Service === 'ses.amazonaws.com'));
  assert.ok(Object.values(storage.Mail.Properties.PublicAccessBlockConfiguration).every(Boolean));
  assert.deepEqual(storage.WorkQueuePolicy.Properties.PolicyDocument.Statement[0].Principal, { Service: 'sns.amazonaws.com' });
  assert.equal(storage.WorkQueue.Properties.RedrivePolicy.maxReceiveCount, 5);
  assert.equal(storage.WorkQueue.Properties.VisibilityTimeout, applicationTemplate().Resources.Worker.Properties.Timeout * 6);
});
test('the app may send only from the two domains; the worker cannot send or delete', () => {
  const app = applicationTemplate().Resources;
  const appPolicy = statements(app.AppRole), workerPolicy = statements(app.WorkerRole);
  const send = appPolicy.find(statement => statement.Action.includes('ses:SendEmail'));
  assert.deepEqual(send.Condition.StringLike['ses:FromAddress'], ['*@example.com', '*@example.org']);
  assert.ok(appPolicy.every(statement => statement.Resource !== '*'));
  assert.doesNotMatch(JSON.stringify(appPolicy), /ses:(Create|Delete|Update|Set)|ReceiptRule|route53|iam:|DbConnectAdmin|incoming/);
  assert.doesNotMatch(JSON.stringify(workerPolicy), /ses:|s3:Delete|DbConnectAdmin|drafts|uploads/); // sqs:DeleteMessage acknowledges records
  assert.equal(app.App.Properties.Environment.Variables.MAIL_MODE, 'real');
  assert.equal(app.AppUrl.Properties.AuthType, 'AWS_IAM');
  assert.equal(applicationTemplate().Parameters.EnableDistribution.Default, 'false');
  assert.deepEqual(app.WorkerSource.Properties.FunctionResponseTypes, ['ReportBatchItemFailures']);
  for (const alarm of [app.DeadLetterAlarm, app.WorkerErrorAlarm]) assert.deepEqual(alarm.Properties.AlarmActions, [{ Ref: 'Alarms' }]);
  assert.deepEqual(app.AlarmEmail.Properties.Endpoint, { Ref: 'OwnerEmail' });
});
test('only the intake buffer expires; recovery versions stay inside 30 days', () => {
  const [versions, intake] = storageTemplate().Resources.Mail.Properties.LifecycleConfiguration.Rules;
  assert.equal(versions.NoncurrentVersionExpiration.NoncurrentDays, 29); assert.equal(versions.ExpirationInDays, undefined);
  assert.equal(intake.Prefix, 'incoming/'); assert.ok(intake.ExpirationInDays + intake.NoncurrentVersionExpiration.NoncurrentDays < 30);
  assert.ok(intake.ExpirationInDays >= storageTemplate().Resources.DeadLetters.Properties.MessageRetentionPeriod / 86400, 'raw mail outlives dead-lettered notifications');
});
test('the receipt rule targets exact recipients in the existing rule set and never stops processing', () => {
  const rule = receivingTemplate().Resources.Rule.Properties;
  assert.equal(rule.RuleSetName, 'exampleorg-support');
  assert.deepEqual(rule.Rule.Actions.map(action => Object.keys(action)[0]), ['S3Action']);
  assert.equal(rule.Rule.Actions[0].S3Action.ObjectKeyPrefix, 'incoming/');
  assert.equal(rule.Rule.TlsPolicy, 'Require'); assert.equal(rule.Rule.ScanEnabled, true);
  assert.match(receivingTemplate().Parameters.RuleName.AllowedPattern, /^\^project-inbox-/);
});

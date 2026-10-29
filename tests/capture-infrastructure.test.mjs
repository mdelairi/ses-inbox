import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTemplate, producerFeedbackTemplate } from '../infra/capture.mjs';
import { recoveryTemplate } from '../infra/production.mjs';
test('capture is independent and private; producer permissions are exact write-only prefixes', () => {
  const template = captureTemplate(), r = template.Resources;
  assert.ok(Buffer.byteLength(JSON.stringify(template, null, 2)) < 51200);
  assert.ok(Object.values(r.Intake.Properties.PublicAccessBlockConfiguration).every(Boolean));
  assert.equal(r.Intake.DeletionPolicy, 'Retain'); assert.equal(r.Intake.Properties.VersioningConfiguration.Status, 'Enabled');
  const grants = r.IntakePolicy.Properties.PolicyDocument.Statement.slice(1).map(row => row['Fn::If'][1]);
  assert.equal(grants.length, 4);
  for (const grant of grants) { assert.equal(grant.Action, 's3:PutObject'); assert.ok(grant.Principal.AWS.Ref.endsWith('RoleArn')); assert.match(grant.Resource['Fn::Sub'], /capture\/(website|exampleorg)-(staging|production)\/\*$/); }
  const statements = r.Role.Properties.Policies[0].PolicyDocument.Statement;
  assert.doesNotMatch(JSON.stringify(statements), /ses:Send|DbConnectAdmin|iam:/);
  assert.ok(statements.every(row => row.Resource !== '*'));
  const deletes = statements.filter(row => row.Action.some(action => action.startsWith('s3:Delete')));
  assert.ok(deletes.every(row => JSON.stringify(row.Resource).includes('Intake')));
  assert.equal(r.Worker.Properties.Environment.Variables.CAPTURE_BUCKET.Ref, 'Intake');
  assert.equal(r.Mapping.Properties.FunctionResponseTypes[0], 'ReportBatchItemFailures');
  assert.ok(!Object.values(r).some(row => row.Type === 'AWS::Lambda::Url'));
  for (const key of ['WebsiteProductionRoleArn', 'WebsiteStagingRoleArn', 'ExampleorgStagingRoleArn', 'ExampleorgProductionRoleArn']) assert.equal(template.Parameters[key].Default, '');
});
test('feedback is additive, source-scoped and keeps SNS provenance', () => {
  const r = captureTemplate().Resources;
  assert.equal(r.WebsiteDestination.Properties.EventDestination.Name, 'project-inbox-capture');
  assert.equal(r.WebsiteSubscription.Properties.RawMessageDelivery, false);
  const producer = producerFeedbackTemplate();
  assert.equal(producer.Resources.Destination.Properties.EventDestination.Name, 'project-inbox-capture');
  const [publish, subscribe] = producer.Resources.Policy.Properties.PolicyDocument.Statement;
  assert.ok(publish.Sid && subscribe.Sid && publish.Sid !== subscribe.Sid, 'SNS requires a distinct ID for each policy statement');
  assert.equal(publish.Principal.Service, 'ses.amazonaws.com');
  assert.ok(publish.Condition.StringEquals['AWS:SourceAccount']); assert.ok(publish.Condition.StringEquals['AWS:SourceArn']);
  assert.equal(subscribe.Condition.StringEquals['sns:Endpoint'].Ref, 'CaptureQueueArn');
  assert.ok(producer.Resources.Destination.Properties.EventDestination.MatchingEventTypes.includes('send'));
});
test('recovery capture cleanup is optional, prefix-limited, and never grants read access to the buffer', () => {
  const template = recoveryTemplate(), r = template.Resources;
  assert.equal(template.Parameters.CaptureBucket.Default, '');
  const statements = r.MaintenanceRole.Properties.Policies[0].PolicyDocument.Statement.filter(row => row['Fn::If']).map(row => row['Fn::If'][1]);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements.map(row => row.Action[0]).sort(), ['s3:DeleteObjectVersion', 's3:ListBucketVersions'].sort());
  assert.equal(r.Maintenance.Properties.Environment.Variables.CAPTURE_BUCKET.Ref, 'CaptureBucket');
});

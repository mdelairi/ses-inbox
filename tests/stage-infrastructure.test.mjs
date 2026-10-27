import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTemplate, artifactTemplate, certificateTemplate } from '../infra/stage.mjs';

test('stage has no real-mail resources or permissions, defaults disabled, and requires signed origin calls', () => {
  const template = applicationTemplate(), resources = template.Resources;
  assert.equal(template.Parameters.EnableDistribution.Default, 'false');
  assert.equal(resources.AppUrl.Properties.AuthType, 'AWS_IAM');
  assert.equal(resources.OriginAccess.Properties.OriginAccessControlConfig.SigningBehavior, 'always');
  assert.equal(resources.UrlPermission.Properties.FunctionUrlAuthType, 'AWS_IAM');
  assert.equal(resources.InvokePermission.Properties.InvokedViaFunctionUrl, true);
  assert.deepEqual(resources.UrlPermission.Properties.SourceArn, resources.InvokePermission.Properties.SourceArn);
  const policy = resources.AppRole.Properties.Policies[0].PolicyDocument;
  assert.doesNotMatch(JSON.stringify(policy), /ses:|s3:|iam:|FullAccess/);
  assert.ok(policy.Statement.every(statement => statement.Resource !== '*'));
  assert.ok(Object.values(resources).every(resource => !/SES|Route53|DSQL/.test(resource.Type)));
});
test('all CloudFront requests reach the auth gateway with no cached auth responses', () => {
  const config = applicationTemplate().Resources.Distribution.Properties.DistributionConfig;
  assert.equal(config.DefaultCacheBehavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.equal(config.DefaultCacheBehavior.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac');
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(config.Origins[0].CustomOriginConfig.OriginProtocolPolicy, 'https-only');
  assert.ok(config.CustomErrorResponses.every(error => error.ErrorCachingMinTTL === 0));
});
test('artifact storage is private, encrypted, TLS-only, versioned and retained; auth identity is retained', () => {
  const artifacts = artifactTemplate().Resources, bucket = artifacts.Artifacts;
  assert.ok(Object.values(bucket.Properties.PublicAccessBlockConfiguration).every(Boolean));
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.deepEqual(artifacts.ArtifactPolicy.Properties.PolicyDocument.Statement[0].Condition, { Bool: { 'aws:SecureTransport': false } });
  const sessions = applicationTemplate().Resources.Sessions;
  assert.equal(sessions.DeletionPolicy, 'Retain'); assert.equal(sessions.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(sessions.Properties.DeletionProtectionEnabled, true);
});
test('toolkit templates fit inline limits and every reference resolves', () => {
  for (const template of [artifactTemplate(), certificateTemplate(), applicationTemplate()]) {
    assert.ok(Buffer.byteLength(JSON.stringify(template, null, 2)) < 51200);
    assert.equal(template.Metadata.AWSToolsMetrics.AWSAgentToolkit, 'aws-cloudformation@2');
    const names = new Set([...Object.keys(template.Resources), ...Object.keys(template.Parameters), 'AWS::StackName', 'AWS::Partition', 'AWS::AccountId']);
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.Ref) assert.ok(names.has(value.Ref), `Missing Ref ${value.Ref}`);
      if (value['Fn::GetAtt']) assert.ok(template.Resources[value['Fn::GetAtt'][0]]);
      if (value['Fn::Sub']) for (const match of value['Fn::Sub'].matchAll(/\$\{([^}]+)\}/g)) assert.ok(names.has(match[1].split('.')[0]), `Missing Sub ${match[1]}`);
      for (const item of Object.values(value)) inspect(item);
    }
    inspect(template);
  }
});

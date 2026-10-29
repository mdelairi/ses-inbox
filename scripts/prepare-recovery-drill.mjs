// Disposable isolated AWS resources for recovery verification. No mail-flow or public endpoints.
import { writeFile } from 'node:fs/promises';
const context = (why, must) => ({ 'com.aws.cloudformation.Context': { why, must } });
const resource = (Type, Properties, why, must) => ({ Type, Properties, Metadata: context(why, must), DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
const tags = [{ Key: 'Project', Value: 'project-inbox-recovery' }, { Key: 'Environment', Value: 'recovery-drill' }, { Key: 'Ephemeral', Value: 'true' }];
const template = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Disposable isolated inbox restore drill: private content bucket and independent DSQL, no runtime mapping or mail flow.',
  Metadata: { AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@2' }, ...context('Approved isolated production recovery drill', ['Never use source storage or attach mail routing', 'Delete only these disposable drill resources after verification']) },
  Resources: {
    Content: resource('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, VersioningConfiguration: { Status: 'Enabled' }, Tags: tags }, 'Private temporary restored content', ['Empty before restore', 'Delete every version before deleting this ephemeral stack']),
    ContentPolicy: { Type: 'AWS::S3::BucketPolicy', Metadata: context('TLS-only access', ['No public or app/worker grants']), Properties: { Bucket: { Ref: 'Content' }, PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [{ 'Fn::GetAtt': ['Content', 'Arn'] }, { 'Fn::Sub': '${Content.Arn}/*' }], Condition: { Bool: { 'aws:SecureTransport': false } } }] } } },
    Database: resource('AWS::DSQL::Cluster', { DeletionProtectionEnabled: false, Tags: tags }, 'Independent temporary target; no restored IAM role mappings', ['Never source cluster', 'No app, worker, SES, DNS or queue integration', 'Deletion enabled only because this is a disposable drill']),
  }, Outputs: { Bucket: { Value: { Ref: 'Content' } }, Host: { Value: { 'Fn::GetAtt': ['Database', 'Endpoint'] } }, ClusterArn: { Value: { 'Fn::GetAtt': ['Database', 'ResourceArn'] } } },
};
await writeFile(new URL('../build/production/templates/recovery-drill.json', import.meta.url), JSON.stringify(template, null, 2) + '\n');
console.log('Prepared disposable recovery drill template. No resources created.');

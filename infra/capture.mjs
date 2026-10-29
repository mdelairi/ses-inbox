// Independent capture storage/queue/worker. Existing SES destinations, receipt rules,
// producer sending switches and mailbox storage remain owned by their projects.
import { accounts } from './accounts.mjs';
const ref = value => ({ Ref: value }), get = (name, field) => ({ 'Fn::GetAtt': [name, field] }), sub = value => ({ 'Fn::Sub': value });
const ctx = (why, must = []) => ({ 'com.aws.cloudformation.Context': { why, must } });
const resource = (Type, Properties, why, must = [], extra = {}) => ({ Type, Properties, Metadata: ctx(why, must), ...extra });
const base = Description => ({ AWSTemplateFormatVersion: '2010-09-09', Description, Metadata: { AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@2' }, ...ctx('Owner-only automated Sent capture', ['Never enable producer sending or replace existing SES feedback destinations', 'No receiving-rule or DNS changes']) } });
const retained = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
const tags = [{ Key: 'Project', Value: 'project-inbox' }, { Key: 'Environment', Value: 'production' }];
const role = account => ({ Type: 'String', Default: '', AllowedPattern: `^$|^arn:aws:iam::${account}:role/.+$`, Description: 'Exact producer role, enabled only after its integration is reviewed' });
const conditional = name => ({ Condition: name });
const maybe = (condition, value) => ({ 'Fn::If': [condition, value, ref('AWS::NoValue')] });
const enabled = parameter => ({ 'Fn::Not': [{ 'Fn::Equals': [ref(parameter), ''] }] });
const topicPolicy = topic => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 'sns:Publish', Resource: ref(topic), Condition: { StringEquals: { 'AWS:SourceAccount': ref('AWS::AccountId'), 'AWS:SourceArn': sub('arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/example-website-production-contact') } } }] });
export function captureTemplate() {
  const bucketName = sub('${AWS::StackName}-${AWS::AccountId}-${AWS::Region}');
  const bucketArn = sub('arn:${AWS::Partition}:s3:::${AWS::StackName}-${AWS::AccountId}-${AWS::Region}');
  const sourceRoles = [['WebsiteProductionRoleArn', 'website-production'], ['WebsiteStagingRoleArn', 'website-staging'], ['ExampleorgStagingRoleArn', 'exampleorg-staging'], ['ExampleorgProductionRoleArn', 'exampleorg-production']];
  return { ...base('Private automated Sent intake, source-scoped writes, durable indexing and additive SES feedback.'), Parameters: {
    ArtifactBucket: { Type: 'String', MinLength: 3 }, ArtifactKey: { Type: 'String', AllowedPattern: '^releases/[a-f0-9]{64}/lambda\\.zip$' },
    MailBucket: { Type: 'String', MinLength: 3 }, MailDatabaseHost: { Type: 'String', AllowedPattern: '^[a-z0-9]+\\.dsql\\.us-east-1\\.on\\.aws$' }, MailDatabaseArn: { Type: 'String', AllowedPattern: '^arn:aws:dsql:us-east-1:[0-9]{12}:cluster/[a-z0-9]+$' },
    AlarmTopicArn: { Type: 'String', AllowedPattern: `^arn:aws:sns:${accounts.region}:${accounts.production}:.+$` },
    WebsiteProductionRoleArn: role(accounts.production), WebsiteStagingRoleArn: role(accounts.staging), ExampleorgStagingRoleArn: role(accounts.staging), ExampleorgProductionRoleArn: role(accounts.production),
    ExampleorgStagingFeedbackTopicArn: { Type: 'String', Default: '', AllowedPattern: `^$|^arn:aws:sns:${accounts.region}:${accounts.staging}:.+$` },
  }, Conditions: { ...Object.fromEntries(sourceRoles.map(([name]) => [`Has${name}`, enabled(name)])), HasStagingFeedback: enabled('ExampleorgStagingFeedbackTopicArn') }, Resources: {
    DeadLetters: resource('AWS::SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600, Tags: tags }, 'Failed capture imports remain visible and alarmed', [], retained),
    Queue: resource('AWS::SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600, VisibilityTimeout: 360, ReceiveMessageWaitTimeSeconds: 20, RedrivePolicy: { deadLetterTargetArn: get('DeadLetters', 'Arn'), maxReceiveCount: 5 }, Tags: tags }, 'Dedicated events, never full email bodies', ['Only this capture bucket and named feedback topics may publish']),
    WebsiteFeedback: resource('AWS::SNS::Topic', { Tags: tags }, 'New additive feedback topic; existing website metrics remain', ['Metadata only; standard SNS'], conditional('HasWebsiteProductionRoleArn')),
    WebsiteFeedbackPolicy: resource('AWS::SNS::TopicPolicy', { Topics: [ref('WebsiteFeedback')], PolicyDocument: topicPolicy('WebsiteFeedback') }, 'SES may publish only from the existing contact configuration set', [], conditional('HasWebsiteProductionRoleArn')),
    QueuePolicy: resource('AWS::SQS::QueuePolicy', { Queues: [ref('Queue')], PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: get('Queue', 'Arn'), Condition: { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') }, ArnEquals: { 'aws:SourceArn': bucketArn } } },
      maybe('HasWebsiteProductionRoleArn', { Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: get('Queue', 'Arn'), Condition: { ArnEquals: { 'aws:SourceArn': ref('WebsiteFeedback') }, StringEquals: { 'aws:SourceAccount': accounts.production } } }),
      maybe('HasStagingFeedback', { Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: get('Queue', 'Arn'), Condition: { ArnEquals: { 'aws:SourceArn': ref('ExampleorgStagingFeedbackTopicArn') }, StringEquals: { 'aws:SourceAccount': accounts.staging } } }),
    ] } }, 'Scope S3 by account/bucket and SNS by exact topic', ['Derive the bucket ARN without Ref to avoid notification-policy cycles']),
    Intake: resource('AWS::S3::Bucket', { BucketName: bucketName, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, VersioningConfiguration: { Status: 'Enabled' }, LifecycleConfiguration: { Rules: [{ Id: 'CaptureBufferBackstop', Prefix: 'capture/', Status: 'Enabled', ExpirationInDays: 14, NoncurrentVersionExpiration: { NoncurrentDays: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] }, NotificationConfiguration: { QueueConfigurations: [{ Event: 's3:ObjectCreated:*', Queue: get('Queue', 'Arn'), Filter: { S3Key: { Rules: [{ Name: 'prefix', Value: 'capture/' }, { Name: 'suffix', Value: '.json' }] } } }] }, Tags: tags }, 'Private short-lived request/outcome buffer, filed copies live in the mailbox', ['Physical 15-day version sweep must be configured in recovery before enabling producers', 'Never a permanent secondary archive', 'Generated account/region name permits policy validation before bucket creation'], { ...retained, DependsOn: 'QueuePolicy' }),
    IntakePolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('Intake'), PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [get('Intake', 'Arn'), sub('${Intake.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': false } } },
      ...sourceRoles.map(([name, id]) => maybe(`Has${name}`, { Effect: 'Allow', Principal: { AWS: ref(name) }, Action: 's3:PutObject', Resource: sub(`\${Intake.Arn}/capture/${id}/*`) })),
    ] } }, 'Each enabled producer gets write-only access to its assigned prefix', ['No producer reads, lists, deletes or accesses production mail']),
    WebsiteDestination: resource('AWS::SES::ConfigurationSetEventDestination', { ConfigurationSetName: 'example-website-production-contact', EventDestination: { Name: 'project-inbox-capture', Enabled: true, MatchingEventTypes: ['send', 'delivery', 'bounce', 'complaint', 'reject', 'deliveryDelay', 'renderingFailure'], SnsDestination: { TopicARN: ref('WebsiteFeedback') } } }, 'Additional destination only; existing metrics are preserved', [], { ...conditional('HasWebsiteProductionRoleArn'), DependsOn: 'WebsiteFeedbackPolicy' }),
    WebsiteSubscription: resource('AWS::SNS::Subscription', { TopicArn: ref('WebsiteFeedback'), Protocol: 'sqs', Endpoint: get('Queue', 'Arn'), RawMessageDelivery: false }, 'Keep topic provenance in the SNS envelope', [], conditional('HasWebsiteProductionRoleArn')),
    StagingSubscription: resource('AWS::SNS::Subscription', { TopicArn: ref('ExampleorgStagingFeedbackTopicArn'), Protocol: 'sqs', Endpoint: get('Queue', 'Arn'), RawMessageDelivery: false }, 'Queue-owner subscription to the dedicated staging feedback topic', ['Staging topic policy must authorize this exact queue endpoint'], conditional('HasStagingFeedback')),
    Logs: resource('AWS::Logs::LogGroup', { RetentionInDays: 14, Tags: tags }, 'Source IDs and outcomes only; never bodies or tokens'),
    Role: resource('AWS::IAM::Role', { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Policies: [{ PolicyName: 'CaptureWorker', PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: get('Logs', 'Arn') },
      { Effect: 'Allow', Action: ['dsql:DbConnect'], Resource: ref('MailDatabaseArn') },
      { Effect: 'Allow', Action: ['s3:PutObject'], Resource: sub('arn:${AWS::Partition}:s3:::${MailBucket}/mail/*') },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:DeleteObjectVersion'], Resource: sub('${Intake.Arn}/capture/*') },
      { Effect: 'Allow', Action: ['s3:ListBucketVersions'], Resource: get('Intake', 'Arn'), Condition: { StringLike: { 's3:prefix': 'capture/*' } } },
      { Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], Resource: get('Queue', 'Arn') },
    ] } }], Tags: tags }, 'Parse and index capture only; runtime uses inbox_capture', ['No SES send, IAM mutation, mailbox object deletion or database administration']),
    Worker: resource('AWS::Lambda::Function', { Runtime: 'nodejs24.x', Architectures: ['arm64'], Handler: 'capture.handler', Role: get('Role', 'Arn'), MemorySize: 1024, Timeout: 60, ReservedConcurrentExecutions: 2, Code: { S3Bucket: ref('ArtifactBucket'), S3Key: ref('ArtifactKey') }, LoggingConfig: { LogGroup: ref('Logs') }, Environment: { Variables: { MAIL_BUCKET: ref('MailBucket'), MAIL_DATABASE_HOST: ref('MailDatabaseHost'), CAPTURE_BUCKET: ref('Intake'), CAPTURE_EVENT_TOPICS: { 'Fn::Join': ['', ['{"website-production":"', { 'Fn::If': ['HasWebsiteProductionRoleArn', ref('WebsiteFeedback'), ''] }, '","exampleorg-staging":"', ref('ExampleorgStagingFeedbackTopicArn'), '"}']] } } }, Tags: tags }, 'Asynchronous captured Sent importer; no public function URL'),
    Mapping: resource('AWS::Lambda::EventSourceMapping', { EventSourceArn: get('Queue', 'Arn'), FunctionName: ref('Worker'), BatchSize: 5, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 2 } }, 'Retry only failed records; never replay the producer SES call'),
    ErrorAlarm: resource('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: ref('Worker') }], Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching', AlarmActions: [ref('AlarmTopicArn')] }, 'Worker crash alarm'),
    QueueAgeAlarm: resource('AWS::CloudWatch::Alarm', { Namespace: 'AWS/SQS', MetricName: 'ApproximateAgeOfOldestMessage', Dimensions: [{ Name: 'QueueName', Value: get('Queue', 'QueueName') }], Statistic: 'Maximum', Period: 300, EvaluationPeriods: 1, Threshold: 300, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching', AlarmActions: [ref('AlarmTopicArn')] }, 'Visible sync delay over five minutes'),
    DeadLetterAlarm: resource('AWS::CloudWatch::Alarm', { Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Dimensions: [{ Name: 'QueueName', Value: get('DeadLetters', 'QueueName') }], Statistic: 'Maximum', Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching', AlarmActions: [ref('AlarmTopicArn')] }, 'Malformed or repeatedly failing imports require intervention'),
  }, Outputs: { CaptureBucket: { Value: ref('Intake') }, CaptureQueueArn: { Value: get('Queue', 'Arn') }, CaptureWorkerRoleArn: { Value: get('Role', 'Arn') }, CaptureWorker: { Value: ref('Worker') } } };
}

// Deploy in staging only after approval; no change to existing ExampleOrg feedback topic.
export function producerFeedbackTemplate() {
  return { ...base('Additive SES feedback for a reviewed producer; existing destinations are untouched.'), Parameters: {
    ConfigurationSet: { Type: 'String', AllowedPattern: '^[a-zA-Z0-9_-]+$' },
    CaptureQueueArn: { Type: 'String', AllowedPattern: `^arn:aws:sqs:${accounts.region}:${accounts.production}:.+$` },
  }, Resources: {
    Topic: resource('AWS::SNS::Topic', {}, 'Dedicated capture metadata feedback, not message bodies'),
    Policy: resource('AWS::SNS::TopicPolicy', { Topics: [ref('Topic')], PolicyDocument: { Version: '2012-10-17', Statement: [
      { Sid: 'AllowSesFeedback', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 'sns:Publish', Resource: ref('Topic'), Condition: { StringEquals: { 'AWS:SourceAccount': ref('AWS::AccountId'), 'AWS:SourceArn': sub('arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/${ConfigurationSet}') } } },
      { Sid: 'AllowInboxQueueSubscription', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${accounts.production}:root` }, Action: 'sns:Subscribe', Resource: ref('Topic'), Condition: { StringEquals: { 'sns:Endpoint': ref('CaptureQueueArn'), 'sns:Protocol': 'sqs' } } },
    ] } }, 'Only SES source config and the Inbox queue-owner subscription'),
    Destination: resource('AWS::SES::ConfigurationSetEventDestination', { ConfigurationSetName: ref('ConfigurationSet'), EventDestination: { Name: 'project-inbox-capture', Enabled: true, MatchingEventTypes: ['send', 'delivery', 'bounce', 'complaint', 'reject', 'deliveryDelay', 'renderingFailure'], SnsDestination: { TopicARN: ref('Topic') } } }, 'Add delivery events without replacing original feedback', [], { DependsOn: 'Policy' }),
  }, Outputs: { TopicArn: { Value: ref('Topic') } } };
}

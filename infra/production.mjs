// Production real-mail environment in the production account. Separate from the staging
// sample templates (infra/stage.mjs), which must never gain SES access.
const ref = value => ({ Ref: value });
const get = (resource, field) => ({ 'Fn::GetAtt': [resource, field] });
const sub = value => ({ 'Fn::Sub': value });
const context = (why, must = []) => ({ 'com.aws.cloudformation.Context': { why, must } });
const resource = (Type, Properties, why, must = [], extra = {}) => ({ Type, Metadata: context(why, must), Properties, ...extra });
const base = Description => ({ AWSTemplateFormatVersion: '2010-09-09', Description, Metadata: { AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@2' }, ...context('Owner-only project inbox for example.com and example.org', ['Never change ExampleOrg, website or existing receipt rules', 'Authenticate every application asset; never cache authenticated responses']) } });
const environment = { Type: 'String', Default: 'production', AllowedValues: ['production'] };
const hostname = { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9-]*\\.example\\.com$' };
const retain = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
const tags = [{ Key: 'Project', Value: 'project-inbox' }, { Key: 'Environment', Value: ref('Environment') }];
const privateBucket = { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, VersioningConfiguration: { Status: 'Enabled' } };
const tlsOnly = bucket => ({ Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [get(bucket, 'Arn'), sub(`\${${bucket}.Arn}/*`)], Condition: { Bool: { 'aws:SecureTransport': false } } });
const lambdaTrust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
const artifactKey = { Type: 'String', AllowedPattern: '^releases/[a-f0-9]{64}/lambda\\.zip$' };
export const RECEIPT_RULE_SET = 'exampleorg-support';
export const RECEIPT_RULE_PREFIX = 'project-inbox-';
export const SENDING_DOMAINS = ['example.com', 'example.org'];

export function artifactTemplate() {
  return { ...base('Private production inbox release artifacts, isolated from mail storage.'), Parameters: { Environment: environment }, Resources: {
    Artifacts: resource('AWS::S3::Bucket', { ...privateBucket, LifecycleConfiguration: { Rules: [{ Id: 'OldReleaseVersions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] }, Tags: tags }, 'Retain private release ZIPs for rollback', [], retain),
    ArtifactPolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('Artifacts'), PolicyDocument: { Version: '2012-10-17', Statement: [tlsOnly('Artifacts')] } }, 'TLS-only release storage'),
  }, Outputs: { ArtifactBucket: { Value: ref('Artifacts') } } };
}

export function certificateTemplate() {
  return { ...base('Inbox TLS certificate; DNS validation is added in the DNS account.'), Parameters: { Hostname: hostname, Environment: environment }, Resources: {
    Certificate: resource('AWS::CertificateManager::Certificate', { DomainName: ref('Hostname'), ValidationMethod: 'DNS', Tags: tags }, 'Certificate for the private inbox hostname', ['Deploy in us-east-1', 'Validation CNAME only'], retain),
  }, Outputs: { CertificateArn: { Value: ref('Certificate') } } };
}

export function storageTemplate() {
  const topicPolicy = topics => resource('AWS::SNS::TopicPolicy', { Topics: topics.map(ref), PolicyDocument: { Version: '2012-10-17', Statement: topics.map(topic => ({ Sid: `SesPublish${topic}`, Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 'sns:Publish', Resource: ref(topic), Condition: { StringEquals: { 'AWS:SourceAccount': ref('AWS::AccountId') } } })) } }, 'Only SES in this account may publish mail notifications and events');
  return { ...base('Production mail storage, database, queues and SES event publishing. All data is retained.'), Parameters: { Environment: environment, Hostname: hostname }, Resources: {
    Mail: resource('AWS::S3::Bucket', { ...privateBucket,
      CorsConfiguration: { CorsRules: [{ AllowedOrigins: [sub('https://${Hostname}')], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposedHeaders: ['ETag'], MaxAge: 300 }] },
      LifecycleConfiguration: { Rules: [{ Id: 'RecoveryVersions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] }, Tags: tags },
    'Raw incoming MIME (incoming/), stored messages and parts (mail/), drafts and uploads', ['Retain on replacement/deletion', 'Current objects never expire', 'Owner-signed short-lived URLs only'], retain),
    MailPolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('Mail'), PolicyDocument: { Version: '2012-10-17', Statement: [tlsOnly('Mail'),
      { Sid: 'SesReceiptWrites', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 's3:PutObject', Resource: sub('${Mail.Arn}/incoming/*'),
        Condition: { StringEquals: { 'AWS:SourceAccount': ref('AWS::AccountId') }, ArnLike: { 'AWS:SourceArn': sub(`arn:\${AWS::Partition}:ses:\${AWS::Region}:\${AWS::AccountId}:receipt-rule-set/${RECEIPT_RULE_SET}:receipt-rule/${RECEIPT_RULE_PREFIX}*`) } } }] } },
    'SES may write raw mail only under incoming/, only from this inbox\'s receipt rules'),
    Database: resource('AWS::DSQL::Cluster', { DeletionProtectionEnabled: true, Tags: tags }, 'Single-region on-demand mail metadata and search index', ['Retain database', 'Runtime roles are scoped, never admin'], retain),
    InboundTopic: resource('AWS::SNS::Topic', { Tags: tags }, 'SES receipt notifications (headers and recipients, never bodies); SES cannot publish to an AWS-managed-key topic'),
    EventsTopic: resource('AWS::SNS::Topic', { Tags: tags }, 'SES delivery, bounce and complaint events for this inbox\'s configuration set'),
    SesTopicPolicy: topicPolicy(['InboundTopic', 'EventsTopic']),
    DeadLetters: resource('AWS::SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600, Tags: tags }, 'Notifications the worker could not process after retries; raw mail stays in S3', [], retain),
    WorkQueue: resource('AWS::SQS::Queue', { SqsManagedSseEnabled: true, VisibilityTimeout: 360, MessageRetentionPeriod: 1209600, RedrivePolicy: { deadLetterTargetArn: get('DeadLetters', 'Arn'), maxReceiveCount: 5 }, Tags: tags }, 'Durable work for incoming mail and delivery events', ['Visibility timeout is six times the worker timeout']),
    WorkQueuePolicy: resource('AWS::SQS::QueuePolicy', { Queues: [ref('WorkQueue')], PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: get('WorkQueue', 'Arn'), Condition: { ArnEquals: { 'aws:SourceArn': [ref('InboundTopic'), ref('EventsTopic')] } } }] } }, 'Only this inbox\'s two topics may enqueue work'),
    InboundSubscription: resource('AWS::SNS::Subscription', { TopicArn: ref('InboundTopic'), Protocol: 'sqs', Endpoint: get('WorkQueue', 'Arn'), RawMessageDelivery: true }, 'Receipt notifications to the worker queue'),
    EventsSubscription: resource('AWS::SNS::Subscription', { TopicArn: ref('EventsTopic'), Protocol: 'sqs', Endpoint: get('WorkQueue', 'Arn'), RawMessageDelivery: true }, 'Delivery events to the worker queue'),
    ConfigurationSet: resource('AWS::SES::ConfigurationSet', { Name: sub('${AWS::StackName}'), SendingOptions: { SendingEnabled: true }, ReputationOptions: { ReputationMetricsEnabled: true }, SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] } }, 'Manual inbox sends only; other projects keep their own sets'),
    ConfigurationSetEvents: resource('AWS::SES::ConfigurationSetEventDestination', { ConfigurationSetName: ref('ConfigurationSet'), EventDestination: { Name: 'inbox-delivery-status', Enabled: true, MatchingEventTypes: ['delivery', 'bounce', 'complaint', 'reject', 'deliveryDelay', 'renderingFailure'], SnsDestination: { TopicARN: ref('EventsTopic') } } }, 'Delivery status for messages sent from the inbox'),
  }, Outputs: {
    MailBucket: { Value: ref('Mail') }, DatabaseHost: { Value: get('Database', 'Endpoint') }, DatabaseArn: { Value: get('Database', 'ResourceArn') },
    WorkQueueArn: { Value: get('WorkQueue', 'Arn') }, DeadLetterQueueName: { Value: get('DeadLetters', 'QueueName') }, InboundTopicArn: { Value: ref('InboundTopic') }, ConfigurationSet: { Value: ref('ConfigurationSet') },
  } };
}

export function applicationTemplate() {
  const distributionArn = sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}');
  const mailObjects = prefixes => prefixes.map(prefix => sub(`arn:\${AWS::Partition}:s3:::\${MailBucket}/${prefix}/*`));
  return { ...base('Private owner-only inbox: sign-in gateway, mail API, worker and CloudFront.'), Parameters: {
    Environment: environment, Hostname: hostname,
    OwnerEmail: { Type: 'String', AllowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    CertificateArn: { Type: 'String', AllowedPattern: '^arn:aws:acm:us-east-1:[0-9]{12}:certificate/.+$' },
    GoogleSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:us-east-1:[0-9]{12}:secret:.+$', Description: 'Secret ARN holding clientId and clientSecret, never the value' },
    ArtifactBucket: { Type: 'String', MinLength: 3 }, ArtifactKey: artifactKey,
    MailBucket: { Type: 'String', MinLength: 3 }, MailDatabaseHost: { Type: 'String', AllowedPattern: '^[a-z0-9]+\\.dsql\\.us-east-1\\.on\\.aws$' }, MailDatabaseArn: { Type: 'String', AllowedPattern: '^arn:aws:dsql:us-east-1:[0-9]{12}:cluster/[a-z0-9]+$' },
    WorkQueueArn: { Type: 'String', AllowedPattern: '^arn:aws:sqs:us-east-1:[0-9]{12}:.+$' }, DeadLetterQueueName: { Type: 'String', MinLength: 1 }, ConfigurationSet: { Type: 'String', MinLength: 1 },
    EnableDistribution: { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'], Description: 'Enable only after DNS, sign-in and database setup are verified' },
  }, Conditions: { Serve: { 'Fn::Equals': [ref('EnableDistribution'), 'true'] } }, Resources: {
    Sessions: resource('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }, DeletionProtectionEnabled: true, Tags: tags }, 'Sign-in records and the pinned owner identity', ['No message contents', 'Owner pin has no TTL'], retain),
    Logs: resource('AWS::Logs::LogGroup', { LogGroupName: sub('/aws/lambda/${AWS::StackName}-app'), RetentionInDays: 14, Tags: tags }, 'Operational errors only', ['Never log OAuth codes, cookies, secrets or message content']),
    WorkerLogs: resource('AWS::Logs::LogGroup', { LogGroupName: sub('/aws/lambda/${AWS::StackName}-worker'), RetentionInDays: 14, Tags: tags }, 'Ids and outcomes only', ['Never log message content']),
    AppRole: resource('AWS::IAM::Role', { AssumeRolePolicyDocument: lambdaTrust, Policies: [{ PolicyName: 'InboxApp', PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], Resource: get('Sessions', 'Arn') },
      { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: ref('GoogleSecretArn') },
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: get('Logs', 'Arn') },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: mailObjects(['mail', 'drafts', 'uploads']) },
      { Effect: 'Allow', Action: ['dsql:DbConnect'], Resource: ref('MailDatabaseArn') },
      { Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: [...SENDING_DOMAINS.map(domain => sub(`arn:\${AWS::Partition}:ses:\${AWS::Region}:\${AWS::AccountId}:identity/${domain}`)), sub('arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:configuration-set/${ConfigurationSet}')],
        Condition: { StringLike: { 'ses:FromAddress': SENDING_DOMAINS.map(domain => `*@${domain}`) } } },
    ] } }], Tags: tags }, 'Sign-in, mail API objects, scoped database login and sending from the two domains', ['No receipt-rule, DNS, database-admin or IAM mutation permission', 'No access to incoming/ raw mail']),
    App: resource('AWS::Lambda::Function', { FunctionName: sub('${AWS::StackName}-app'), Runtime: 'nodejs24.x', Architectures: ['arm64'], Handler: 'index.handler', MemorySize: 512, Timeout: 30, ReservedConcurrentExecutions: 10, Role: get('AppRole', 'Arn'), Code: { S3Bucket: ref('ArtifactBucket'), S3Key: ref('ArtifactKey') },
      Environment: { Variables: { PUBLIC_ORIGIN: sub('https://${Hostname}'), OWNER_EMAIL: ref('OwnerEmail'), AUTH_TABLE: ref('Sessions'), GOOGLE_SECRET_ARN: ref('GoogleSecretArn'), MAIL_BUCKET: ref('MailBucket'), MAIL_DATABASE_HOST: ref('MailDatabaseHost'), MAIL_MODE: 'real', MAIL_ENVIRONMENT: 'production', SES_CONFIGURATION_SET: ref('ConfigurationSet') } }, Tags: tags },
    'Owner-only sign-in gateway and mail API', ['Protect every asset and API', 'No provisioned concurrency']),
    WorkerRole: resource('AWS::IAM::Role', { AssumeRolePolicyDocument: lambdaTrust, Policies: [{ PolicyName: 'InboxWorker', PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: get('WorkerLogs', 'Arn') },
      { Effect: 'Allow', Action: ['s3:GetObject'], Resource: mailObjects(['incoming', 'mail']) },
      { Effect: 'Allow', Action: ['s3:PutObject'], Resource: mailObjects(['mail']) },
      { Effect: 'Allow', Action: ['dsql:DbConnect'], Resource: ref('MailDatabaseArn') },
      { Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], Resource: ref('WorkQueueArn') },
    ] } }], Tags: tags }, 'Parse and file incoming mail, record delivery events', ['Cannot send mail or delete objects']),
    Worker: resource('AWS::Lambda::Function', { FunctionName: sub('${AWS::StackName}-worker'), Runtime: 'nodejs24.x', Architectures: ['arm64'], Handler: 'worker.handler', MemorySize: 1024, Timeout: 60, ReservedConcurrentExecutions: 2, Role: get('WorkerRole', 'Arn'), Code: { S3Bucket: ref('ArtifactBucket'), S3Key: ref('ArtifactKey') },
      Environment: { Variables: { MAIL_BUCKET: ref('MailBucket'), MAIL_DATABASE_HOST: ref('MailDatabaseHost'), MAIL_ENVIRONMENT: 'production' } }, Tags: tags }, 'Bounded concurrency keeps database contention low; parsing 40 MB mail needs memory'),
    WorkerSource: resource('AWS::Lambda::EventSourceMapping', { EventSourceArn: ref('WorkQueueArn'), FunctionName: ref('Worker'), BatchSize: 5, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 2 } }, 'Only failed records are retried; repeated failures reach the dead-letter queue'),
    DeadLetterAlarm: resource('AWS::CloudWatch::Alarm', { Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Dimensions: [{ Name: 'QueueName', Value: ref('DeadLetterQueueName') }], Statistic: 'Maximum', Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' }, 'Mail that could not be filed after retries'),
    WorkerErrorAlarm: resource('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: ref('Worker') }], Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' }, 'Worker crashes'),
    AppUrl: resource('AWS::Lambda::Url', { TargetFunctionArn: get('App', 'Arn'), AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' }, 'Signed CloudFront origin only', ['Never change AuthType to NONE']),
    OriginAccess: resource('AWS::CloudFront::OriginAccessControl', { OriginAccessControlConfig: { Name: sub('${AWS::StackName}-lambda'), OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always', SigningProtocol: 'sigv4' } }, 'Sign CloudFront origin requests'),
    Distribution: resource('AWS::CloudFront::Distribution', { DistributionConfig: { Enabled: { 'Fn::If': ['Serve', true, false] }, Comment: sub('${AWS::StackName} private inbox'), Aliases: [ref('Hostname')], HttpVersion: 'http2', IPV6Enabled: true, PriceClass: 'PriceClass_100',
      ViewerCertificate: { AcmCertificateArn: ref('CertificateArn'), SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
      Origins: [{ Id: 'PrivateApp', DomainName: { 'Fn::Select': [2, { 'Fn::Split': ['/', get('AppUrl', 'FunctionUrl')] }] }, OriginAccessControlId: get('OriginAccess', 'Id'), CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] } }],
      DefaultCacheBehavior: { TargetOriginId: 'PrivateApp', ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], CachedMethods: ['GET', 'HEAD'], Compress: true, CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac' },
      CustomErrorResponses: [403, 500, 502, 503, 504].map(ErrorCode => ({ ErrorCode, ErrorCachingMinTTL: 0 })) }, Tags: tags }, 'Dedicated distribution; caching disabled for all authenticated responses', ['No shared public-site distribution edits']),
    UrlPermission: resource('AWS::Lambda::Permission', { FunctionName: get('App', 'Arn'), Action: 'lambda:InvokeFunctionUrl', Principal: 'cloudfront.amazonaws.com', SourceArn: distributionArn, FunctionUrlAuthType: 'AWS_IAM' }, 'Only this distribution may invoke the function URL'),
    InvokePermission: resource('AWS::Lambda::Permission', { FunctionName: get('App', 'Arn'), Action: 'lambda:InvokeFunction', Principal: 'cloudfront.amazonaws.com', SourceArn: distributionArn, InvokedViaFunctionUrl: true }, 'Second permission required by function URL authorization'),
  }, Outputs: {
    DistributionId: { Value: ref('Distribution') }, DistributionDomain: { Value: get('Distribution', 'DomainName') }, FunctionUrl: { Value: get('AppUrl', 'FunctionUrl') },
    AuthTable: { Value: ref('Sessions') }, AppRoleArn: { Value: get('AppRole', 'Arn') }, WorkerRoleArn: { Value: get('WorkerRole', 'Arn') },
  } };
}

// Phase 3: one rule per rollout step, added to the existing active rule set. The rule set and
// ExampleOrg's StoreSupport rule stay owned by the ExampleOrg stack.
export function receivingTemplate() {
  return { ...base('Inbox receipt rule in the existing production rule set; StoreSupport is untouched.'), Parameters: {
    MailBucket: { Type: 'String', MinLength: 3 }, InboundTopicArn: { Type: 'String', AllowedPattern: '^arn:aws:sns:us-east-1:[0-9]{12}:.+$' },
    RuleName: { Type: 'String', AllowedPattern: `^${RECEIPT_RULE_PREFIX}[a-z0-9-]+$` },
    Recipients: { Type: 'CommaDelimitedList', Description: 'Exact addresses this rule accepts, never a whole domain' },
  }, Rules: { ExactRecipients: { Assertions: [{ Assert: { 'Fn::Not': [{ 'Fn::Contains': [ref('Recipients'), ''] }] }, AssertDescription: 'List exact addresses' }] } }, Resources: {
    Rule: resource('AWS::SES::ReceiptRule', { RuleSetName: RECEIPT_RULE_SET, Rule: { Name: ref('RuleName'), Enabled: true, TlsPolicy: 'Require', ScanEnabled: true, Recipients: ref('Recipients'),
      Actions: [{ S3Action: { BucketName: ref('MailBucket'), ObjectKeyPrefix: 'incoming/', TopicArn: ref('InboundTopicArn') } }] } }, 'Store and announce mail for the listed inbox addresses only', ['Never list support@example.org until its cutover is reviewed', 'No Stop action, so other rules still see unrelated mail']),
  } };
}

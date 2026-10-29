import { createCloudPush, createCloudResources } from './cloud.mjs';
import { createWorker } from './worker.mjs';

const region = process.env.AWS_REGION;
const resources = createCloudResources({ bucket: process.env.MAIL_BUCKET, host: process.env.MAIL_DATABASE_HOST, region, user: 'inbox_worker' });
export const handler = createWorker({ ...resources, bucket: process.env.MAIL_BUCKET, environment: process.env.MAIL_ENVIRONMENT || 'production', configurationSet: process.env.SES_CONFIGURATION_SET,
  push: createCloudPush({ pool: resources.pool, region, secretArn: process.env.VAPID_SECRET_ARN }) });

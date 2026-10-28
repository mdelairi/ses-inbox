import { createCloudResources } from './cloud.mjs';
import { createWorker } from './worker.mjs';

const resources = createCloudResources({ bucket: process.env.MAIL_BUCKET, host: process.env.MAIL_DATABASE_HOST, region: process.env.AWS_REGION, user: 'inbox_worker' });
export const handler = createWorker({ ...resources, bucket: process.env.MAIL_BUCKET, environment: process.env.MAIL_ENVIRONMENT || 'production' });

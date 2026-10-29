import { createCloudResources } from '../mail/cloud.mjs';
import { createObjectStore } from '../mail/maintenance-store.mjs';
import { createCaptureWorker } from './worker.mjs';
import { captureSources } from '../mail/capture-sources.mjs';
const { MAIL_BUCKET: bucket, MAIL_DATABASE_HOST: host, CAPTURE_BUCKET: captureBucket, AWS_REGION: region } = process.env;
const resources = createCloudResources({ bucket, host, region, user: 'inbox_capture' });
const topics = JSON.parse(process.env.CAPTURE_EVENT_TOPICS || '{}');
const sources = Object.fromEntries(Object.entries(captureSources).map(([id, value]) => [id, { ...value, eventTopicArn: topics[id] || null }]));
export const handler = createCaptureWorker({ ...resources, captureObjects: createObjectStore({ bucket: captureBucket, region }), bucket, captureBucket, sources });

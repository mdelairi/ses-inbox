import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, paginateListObjectsV2 } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { createMailApi } from './api.mjs';
import { createPush } from './push.mjs';

// VAPID keys live in one secret ({ publicKey, privateKey, subject }); read once per container.
export function createCloudPush({ pool, region, secretArn }) {
  if (!secretArn) return undefined;
  const secrets = new SecretsManagerClient({ region, maxAttempts: 2 });
  let keys;
  const vapid = async () => {
    if (!keys) {
      const value = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString);
      if (typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string' || !/^mailto:/.test(value.subject || '')) throw new Error('InvalidVapidSecret');
      keys = value;
    }
    return keys;
  };
  return createPush({ pool, vapid });
}

// One private bucket: SES writes incoming/, the app owns mail/, drafts/ and uploads/.
export function createCloudResources({ bucket, host, region, user = 'inbox_mail' }) {
  const s3 = new S3Client({ region, maxAttempts: 2 });
  const send = command => s3.send(command, { abortSignal: AbortSignal.timeout(20000) });
  const pool = new AuroraDSQLPool({ host, user, region, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, maxLifetimeSeconds: 300, ssl: { rejectUnauthorized: true } });
  pool.on('error', () => {}); // The next request reconnects; never log connection or token material.
  const objects = {
    async get(Key) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key })); return Body.transformToString(); },
    async getBytes(Key) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key })); return Buffer.from(await Body.transformToByteArray()); },
    async getRaw(Bucket, Key) { if (Bucket !== bucket) throw new Error('UnexpectedBucket'); return this.getBytes(Key); },
    async put(Key, Body, ContentType = 'application/octet-stream') { await send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType, CacheControl: 'private,no-store' })); },
    async remove(Key) { await send(new DeleteObjectCommand({ Bucket: bucket, Key })); },
    async listCurrent(Prefix) {
      const keys = [];
      for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: bucket, Prefix })) for (const item of page.Contents || []) keys.push(item.Key);
      return keys;
    },
    // Always a download, never rendered inline from the bucket origin.
    async downloadUrl(Key, name) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key, ResponseContentType: 'application/octet-stream', ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name || 'attachment')}`, ResponseCacheControl: 'private,no-store' }), { expiresIn: 60 });
    },
    async uploadUrl(Key, sha256, size) {
      const checksum = Buffer.from(sha256, 'hex').toString('base64');
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key, ContentLength: size, ContentType: 'application/octet-stream', ChecksumSHA256: checksum }), { expiresIn: 60, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
      return { url, headers: { 'content-type': 'application/octet-stream', 'x-amz-checksum-sha256': checksum } };
    },
  };
  const sesClient = new SESv2Client({ region, maxAttempts: 1 }); // Never let the SDK retry a send.
  const ses = {
    async sendRaw({ from, destination, raw, configurationSet }) {
      const result = await sesClient.send(new SendEmailCommand({ FromEmailAddress: from, Destination: destination, Content: { Raw: { Data: raw } }, ConfigurationSetName: configurationSet }), { abortSignal: AbortSignal.timeout(15000) });
      return { messageId: result.MessageId };
    },
  };
  return { pool, objects, ses };
}

export function createRealMailApi({ bucket, host, region, configurationSet, environment = 'production', vapidSecretArn }) {
  const resources = createCloudResources({ bucket, host, region });
  return createMailApi({ ...resources, bucket, configurationSet, environment, push: createCloudPush({ pool: resources.pool, region, secretArn: vapidSecretArn }) });
}

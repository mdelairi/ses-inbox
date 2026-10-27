import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { createMailApi } from './mail-api.mjs';

export function createCloudMailApi({ bucket, host, region }) {
  const s3 = new S3Client({ region, maxAttempts: 2 });
  const pool = new AuroraDSQLPool({ host, user: 'inbox_stage', region, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, maxLifetimeSeconds: 300, ssl: { rejectUnauthorized: true } });
  pool.on('error', () => {}); // A subsequent request reconnects; never log connection/token material.
  const heads = {
    async get(owner) {
      const { rows } = await pool.query('SELECT revision, object_key, digest, write_id FROM inbox_stage.workspace WHERE owner_key=$1', [owner]);
      const row = rows[0]; return row && { revision: row.revision, objectKey: row.object_key, digest: row.digest, writeId: row.write_id };
    },
    async compareAndSwap(owner, revision, next) {
      try {
        const { rowCount } = revision === 0
          ? await pool.query('INSERT INTO inbox_stage.workspace(owner_key,revision,object_key,digest,write_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [owner, next.revision, next.objectKey, next.digest, next.writeId])
          : await pool.query('UPDATE inbox_stage.workspace SET revision=$2,object_key=$3,digest=$4,write_id=$5 WHERE owner_key=$1 AND revision=$6', [owner, next.revision, next.objectKey, next.digest, next.writeId, revision]);
        return rowCount === 1;
      } catch (error) { if (['40001', '23505'].includes(error.code)) return false; throw error; }
    },
  };
  const objects = {
    async read(Key) { const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key })); return Body.transformToString(); },
    async write(Key, Body) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType: 'application/json', CacheControl: 'private,no-store' })); },
    async remove(Key) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })); },
    async head(Key) { const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key, ChecksumMode: 'ENABLED' })); return { size: result.ContentLength, sha256: Buffer.from(result.ChecksumSHA256 || '', 'base64').toString('hex') }; },
    async downloadUrl(Key) { return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key, ResponseContentType: 'application/octet-stream', ResponseContentDisposition: 'attachment', ResponseCacheControl: 'private,no-store' }), { expiresIn: 60 }); },
    async uploadUrl(Key, sha256, size) {
      const checksum = Buffer.from(sha256, 'hex').toString('base64');
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key, ContentLength: size, ContentType: 'application/octet-stream', ChecksumSHA256: checksum }), { expiresIn: 60, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
      return { url, headers: { 'content-type': 'application/octet-stream', 'x-amz-checksum-sha256': checksum } };
    },
  };
  return createMailApi({ heads, objects });
}

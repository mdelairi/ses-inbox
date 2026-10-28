import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, paginateListObjectVersions } from '@aws-sdk/client-s3';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { createHeads } from './retention-store.mjs';
import { scopedKey } from './retention.mjs';

export function createMaintenanceStore({ bucket, host, region, profile, user = 'inbox_maintenance' }) {
  const s3 = new S3Client({ region, maxAttempts: 2, ...(profile ? { profile } : {}) });
  const pool = new AuroraDSQLPool({ host, region, user, ...(profile ? { profile } : {}), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, maxLifetimeSeconds: 300, ssl: { rejectUnauthorized: true } });
  pool.on('error', () => {});
  const send = command => s3.send(command, { abortSignal: AbortSignal.timeout(20000) });
  const objects = {
    async read(Key) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key })); return Body.transformToString(); },
    async readVersion(Key, VersionId) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key, VersionId })); return Body.transformToString(); },
    async readVersionBytes(Key, VersionId) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key, VersionId })); return Buffer.from(await Body.transformToByteArray()); },
    async write(Key, Body) { await send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType: 'application/json', CacheControl: 'private,no-store' })); },
    async writeBytes(Key, Body, sha256) { await send(new PutObjectCommand({ Bucket: bucket, Key, Body, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), ContentType: 'application/octet-stream' })); },
    async remove(Key) { await send(new DeleteObjectCommand({ Bucket: bucket, Key })); },
    async purge(Key, VersionId) { if (!VersionId) throw new Error('MissingPurgeVersion'); await send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId })); },
    async versions(owner, exactKey) {
      if (!/^[a-f0-9]{64}$/.test(owner) || (exactKey && !scopedKey(owner, exactKey))) throw new Error('InvalidVersionScope');
      const result = []; let pages = 0;
      for await (const page of paginateListObjectVersions({ client: s3 }, { Bucket: bucket, Prefix: exactKey || `samples/${owner}/`, MaxKeys: 1000 })) {
        if (++pages > 100) throw new Error('VersionListingLimit');
        for (const [items, deleteMarker] of [[page.Versions || [], false], [page.DeleteMarkers || [], true]]) for (const item of items) {
          if (exactKey && item.Key !== exactKey) continue;
          if (!scopedKey(owner, item.Key)) throw new Error('VersionScopeMismatch');
          result.push({ objectKey: item.Key, versionId: item.VersionId, isLatest: item.IsLatest, deleteMarker, lastModified: item.LastModified.toISOString() });
        }
      }
      return result;
    },
  };
  return { heads: createHeads(pool), objects, close: () => pool.end() };
}

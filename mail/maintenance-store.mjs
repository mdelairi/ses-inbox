import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand, paginateListObjectsV2 } from '@aws-sdk/client-s3';
import { validLedger } from './backup.mjs';

export function createObjectStore({ bucket, region, credentials }) {
  const client = new S3Client({ region, credentials, maxAttempts: 2 });
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(20000) });
  const store = {
    async getBytes(Key, VersionId) { const { Body } = await send(new GetObjectCommand({ Bucket: bucket, Key, VersionId })); return Buffer.from(await Body.transformToByteArray()); },
    async get(Key) { return (await store.getBytes(Key)).toString(); },
    async put(Key, Body, ContentType = 'application/octet-stream') { await send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType, CacheControl: 'private,no-store' })); },
    async remove(Key) { await send(new DeleteObjectCommand({ Bucket: bucket, Key })); },
    async removeVersion(Key, VersionId) { if (!VersionId) throw new Error('VersionRequired'); await send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId })); },
    async listCurrent(Prefix) {
      const keys = [];
      for await (const page of paginateListObjectsV2({ client }, { Bucket: bucket, Prefix })) for (const item of page.Contents || []) keys.push(item.Key);
      return keys;
    },
    async versions(Prefix) {
      const result = [];
      let KeyMarker, VersionIdMarker;
      for (;;) {
        const page = await send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix, KeyMarker, VersionIdMarker }));
        for (const [items, deleteMarker] of [[page.Versions, false], [page.DeleteMarkers, true]]) for (const row of items || []) result.push({ key: row.Key, versionId: row.VersionId, isLatest: row.IsLatest, lastModified: row.LastModified.toISOString(), deleteMarker });
        if (!page.IsTruncated) break;
        if (!page.NextKeyMarker || (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker)) throw new Error('InvalidVersionPagination');
        KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
      }
      return result;
    },
    async getRecoverable(key) {
      try { return await store.getBytes(key); }
      catch (error) {
        if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
        // Objects used by drafts/committed messages are immutable. A concurrent
        // discard/purge may add a delete marker after the SQL snapshot was read.
        const versions = (await store.versions(key)).filter(row => row.key === key && !row.deleteMarker).sort((a, b) => +new Date(b.lastModified) - +new Date(a.lastModified));
        if (!versions.length) throw error;
        return store.getBytes(key, versions[0].versionId);
      }
    },
    async ledger() {
      const rows = [];
      for (const key of await store.listCurrent('tombstones/')) {
        const row = validLedger(JSON.parse(await store.get(key)));
        if (key !== `tombstones/${row.domain_id}/${row.alias_id}/${row.message_id}.json`) throw new Error('InvalidDeletionLedgerKey');
        rows.push(row);
      }
      return rows;
    },
  };
  return store;
}

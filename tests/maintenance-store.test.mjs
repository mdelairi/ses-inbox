import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { hash } from '../stage/retention.mjs';

// Exercises the real AWS adapter module with a stubbed S3 transport, so a
// missing SDK export fails here rather than in the deployed cleanup Lambda.
const stageDeps = existsSync(new URL('../stage/node_modules/@aws-sdk/client-s3', import.meta.url));
test('object versions follow S3 key/version markers across pages and stay owner-scoped', { skip: !stageDeps && 'install stage dependencies first' }, async t => {
  const { S3Client } = createRequire(new URL('../stage/package.json', import.meta.url))('@aws-sdk/client-s3');
  const { createMaintenanceStore } = await import('../stage/maintenance-store.mjs');
  const owner = hash('owner'), key = name => `samples/${owner}/states/${name}.json`, at = new Date('2026-10-28T00:00:00Z');
  const pages = [
    { IsTruncated: true, NextKeyMarker: key('a'), NextVersionIdMarker: 'v1', Versions: [{ Key: key('a'), VersionId: 'v1', IsLatest: true, LastModified: at }] },
    { IsTruncated: false, DeleteMarkers: [{ Key: key('b'), VersionId: 'v2', IsLatest: true, LastModified: at }] },
  ];
  const requests = [];
  t.mock.method(S3Client.prototype, 'send', async command => { requests.push(command.input); return pages[requests.length - 1]; });
  const store = createMaintenanceStore({ bucket: 'bucket', host: 'cluster.dsql.us-east-1.on.aws', region: 'us-east-1' });
  try {
    const versions = await store.objects.versions(owner);
    assert.deepEqual(versions.map(item => [item.objectKey, item.versionId, item.deleteMarker]), [[key('a'), 'v1', false], [key('b'), 'v2', true]]);
    assert.deepEqual(requests.map(input => [input.Prefix, input.KeyMarker, input.VersionIdMarker]), [[`samples/${owner}/`, undefined, undefined], [`samples/${owner}/`, key('a'), 'v1']]);
    pages.push({ IsTruncated: false, Versions: [{ Key: `samples/${hash('other')}/states/x.json`, VersionId: 'v3', IsLatest: true, LastModified: at }] });
    await assert.rejects(store.objects.versions(owner), /VersionScopeMismatch/);
  } finally { await store.close(); }
});

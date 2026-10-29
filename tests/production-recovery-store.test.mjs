import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createObjectStore } from '../mail/maintenance-store.mjs';

test('version pagination includes delete markers across pages and recovers only the exact key', async t => {
  const calls = [], at = new Date('2026-10-28T12:00:00Z');
  t.mock.method(S3Client.prototype, 'send', async command => {
    calls.push(command.input);
    if (command.constructor.name === 'GetObjectCommand') {
      if (!command.input.VersionId) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      assert.equal(command.input.Key, 'mail/a'); assert.equal(command.input.VersionId, 'v1');
      return { Body: { transformToByteArray: async () => Buffer.from('retired') } };
    }
    if (!command.input.KeyMarker) return { IsTruncated: true, NextKeyMarker: 'mail/a', NextVersionIdMarker: 'd1', DeleteMarkers: [{ Key: 'mail/a', VersionId: 'd1', IsLatest: true, LastModified: at }] };
    assert.equal(command.input.KeyMarker, 'mail/a'); assert.equal(command.input.VersionIdMarker, 'd1');
    return { IsTruncated: false, Versions: [{ Key: 'mail/a', VersionId: 'v1', IsLatest: false, LastModified: at }, { Key: 'mail/ab', VersionId: 'wrong', IsLatest: true, LastModified: new Date(+at + 1) }] };
  });
  const store = createObjectStore({ bucket: 'private', region: 'us-east-1' });
  assert.equal((await store.getRecoverable('mail/a')).toString(), 'retired');
  assert.equal(calls.length, 4);
});

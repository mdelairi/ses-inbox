import { digest } from './backup.mjs';

// Re-runnable migration for the first production release's incoming/ references.
// No mailbox state or intake objects are removed. Dry-run is the default.
export async function preserveRaw({ pool, objects, bucket, apply = false, checkTime = () => {} }) {
  const { rows } = await pool.query('SELECT m.domain_id, m.message_id, m.object_manifest_key FROM mail.messages m WHERE EXISTS (SELECT 1 FROM mail.mailbox_entries e WHERE e.domain_id=m.domain_id AND e.message_id=m.message_id)');
  const result = { inspected: rows.length, needsCopy: 0, preserved: 0, missing: 0, applied: apply };
  for (const row of rows) {
    checkTime();
    const manifest = JSON.parse(await objects.get(row.object_manifest_key));
    if (!manifest.raw?.key?.startsWith('incoming/')) continue;
    result.needsCopy++;
    if (manifest.raw.bucket !== bucket) throw new Error('UnexpectedRawBucket');
    const key = `mail/${row.domain_id}/${row.message_id}/raw.eml`;
    let bytes;
    try { bytes = await objects.getRecoverable(manifest.raw.key); }
    catch (error) { if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) { result.missing++; continue; } throw error; }
    if (!apply) continue;
    await objects.put(key, bytes, 'message/rfc822');
    if (digest(await objects.getBytes(key)) !== digest(bytes)) throw new Error('RawCopyVerificationFailed');
    // Only this migration changes committed message manifests; each run is idempotent.
    manifest.raw = { bucket, key };
    await objects.put(row.object_manifest_key, JSON.stringify(manifest), 'application/json');
    result.preserved++;
  }
  if (result.missing) throw Object.assign(new Error('OriginalRawMissing'), { result });
  return result;
}

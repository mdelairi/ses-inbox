import { randomUUID } from 'node:crypto';
import { DAY, ORPHAN_GRACE_MS, RECOVERY_DAYS, entries, fileKeys, hash, mergeMissing, retirement, scopedKey, withoutDeleted } from './retention.mjs';
import { fileReferences, validateState } from './mail-api.mjs';

export function objectKind(owner, key) {
  if (!scopedKey(owner, key)) return null;
  const path = key.slice(`samples/${owner}/`.length);
  if (/^states\/[a-f0-9-]{36}\.json$/.test(path)) return 'state';
  if (/^files\/(?:[a-f0-9-]{36}\/)?[a-f0-9]{64}$/.test(path)) return 'file';
  return null;
}
async function readCurrent(heads, objects, owner) {
  const head = await heads.get(owner);
  if (!head) throw new Error('RecoveryAuthorityUnavailable');
  const text = await objects.read(head.objectKey);
  if (hash(text) !== head.digest) throw new Error('CurrentStateIntegrityFailure');
  return { head, state: withoutDeleted(JSON.parse(text), await heads.tombstones(owner)) };
}
export async function reconcileOwner({ heads, objects, owner, now = Date.now() }) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('InvalidCleanupOwner');
  const token = randomUUID();
  if (!await heads.claim(owner, token)) throw new Error('MaintenanceLockBusy');
  const result = { retired: 0, deletedVersions: 0, expiredVersionsRemaining: 0, deadlineBreaches: 0 };
  try {
    const { head, state } = await readCurrent(heads, objects, owner);
    const protectedKeys = fileKeys(state); protectedKeys.add(head.objectKey);
    const versions = await objects.versions(owner), groups = new Map();
    for (const version of versions) {
      if (!objectKind(owner, version.objectKey)) throw new Error('UnexpectedObjectInCleanupScope');
      if (!groups.has(version.objectKey)) groups.set(version.objectKey, []);
      groups.get(version.objectKey).push(version);
    }
    const records = new Map((await heads.retired(owner)).map(item => [item.objectKey, item]));
    for (const [key, group] of groups) {
      if (protectedKeys.has(key)) {
        if (records.has(key)) throw new Error('RetiredObjectStillReferenced');
        // Never delete the live version, even when mail is old or in Trash.
        // Duplicate noncurrent versions have identical immutable-key content.
        for (const version of group) if (!version.isLatest && now - +new Date(version.lastModified) >= RECOVERY_DAYS * DAY) {
          await objects.purge(key, version.versionId); result.deletedVersions++;
        }
        continue;
      }
      if (!records.has(key)) {
        const latest = Math.max(...group.map(version => +new Date(version.lastModified)));
        if (now - latest < ORPHAN_GRACE_MS) continue;
        // Legacy/uncommitted objects have no reliable unreference timestamp.
        // Conservatively age them from creation; new publications record exact retirement.
        const first = Math.min(...group.map(version => +new Date(version.lastModified)));
        const item = retirement(key, 'orphan', first);
        await heads.retire(owner, token, item); records.set(key, item); result.retired++;
      }
    }
    for (const [key, item] of records) {
      if (!objectKind(owner, key) || protectedKeys.has(key)) throw new Error('UnsafeRetirementRecord');
      const group = groups.get(key) || [];
      if (now >= +new Date(item.purgeAfter)) {
        // Data versions first; delete markers last. The durable retired record
        // fences reattachment until the complete absence of all versions is verified.
        for (const version of [...group].sort((a, b) => Number(a.deleteMarker) - Number(b.deleteMarker))) {
          await objects.purge(key, version.versionId); result.deletedVersions++;
        }
        const remaining = await objects.versions(owner, key);
        if (remaining.length) {
          result.expiredVersionsRemaining += remaining.length;
          if (now >= +new Date(item.purgeAfter) + DAY) result.deadlineBreaches++;
        } else await heads.forgetRetired(owner, token, key);
      } else if (group.some(version => version.isLatest && !version.deleteMarker)) await objects.remove(key);
    }
    return result;
  } finally { await heads.release(owner, token); }
}

export async function recoverMissing({ heads, objects, owner, objectKey, versionId, expectedRevision, apply = false, repairUnreadable = false, now = Date.now() }) {
  if (objectKind(owner, objectKey) !== 'state' || typeof versionId !== 'string' || !versionId) throw new Error('InvalidRecoverySource');
  const token = randomUUID();
  if (!await heads.claim(owner, token)) throw new Error('MaintenanceLockBusy');
  try {
    const head = await heads.get(owner);
    if (!head) throw new Error('RecoveryAuthorityUnavailable');
    if (head.revision !== expectedRevision) throw new Error('RecoveryRevisionChanged');
    const source = (await heads.retired(owner)).find(item => item.objectKey === objectKey);
    if (!source || source.kind !== 'state' || !source.digest || now >= +new Date(source.purgeAfter)) throw new Error('RecoveryWindowExpiredOrUnverified');
    const text = await objects.readVersion(objectKey, versionId);
    if (hash(text) !== source.digest) throw new Error('RecoveryStateIntegrityFailure');
    const original = JSON.parse(text), tombstones = await heads.tombstones(owner), recovered = withoutDeleted(original, tombstones);
    let current, unreadable = false;
    try { current = await readCurrent(heads, objects, owner); }
    catch {
      // The separate, live ledger must be readable before any corruption repair.
      await heads.tombstones(owner);
      unreadable = true;
      current = { head, state: { ...structuredClone(recovered), messages: [], drafts: [], deleted: [] } };
    }
    const merged = mergeMissing(current.state, recovered);
    const report = { revision: current.head.revision, unreadableCurrent: unreadable, added: merged.added, blockedMailboxCopies: entries(original).filter(entry => entry.kind === 'message').length - entries(recovered).filter(entry => entry.kind === 'message').length, applied: false };
    if (!apply) return report;
    if (unreadable && !repairUnreadable) throw new Error('ExplicitUnreadableRepairRequired');
    const active = fileKeys(current.state), copied = new Map(), retired = new Map((await heads.retired(owner)).map(item => [item.objectKey, item]));
    for (const file of fileReferences(merged.state)) if (!active.has(file.objectKey)) {
      if (!copied.has(file.objectKey)) {
        const old = file.objectKey, retirement = retired.get(old);
        if (retirement && now >= +new Date(retirement.purgeAfter)) throw new Error('RecoveryFileExpired');
        if (objectKind(owner, old) !== 'file') throw new Error('RecoveryFileOutsideOwner');
        const candidates = (await objects.versions(owner, old)).filter(version => !version.deleteMarker);
        const sourceVersion = candidates.sort((a, b) => +new Date(b.lastModified) - +new Date(a.lastModified))[0];
        if (!sourceVersion) throw new Error('RecoveryFileMissing');
        const bytes = await objects.readVersionBytes(old, sourceVersion.versionId);
        if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('RecoveryFileIntegrityFailure');
        const fresh = `samples/${owner}/files/${randomUUID()}/${file.sha256}`;
        await objects.writeBytes(fresh, bytes, file.sha256); copied.set(old, fresh);
      }
      file.objectKey = copied.get(file.objectKey);
    }
    validateState(merged.state, owner);
    const body = JSON.stringify(merged.state), key = `samples/${owner}/states/${randomUUID()}.json`;
    await objects.write(key, body);
    // Restore is additive, uses fresh object keys, and never rewinds the deletion ledger.
    const next = { objectKey: key, revision: expectedRevision + 1, digest: hash(body), writeId: randomUUID() };
    await heads.publishRecovery(owner, token, expectedRevision, next, { ...retirement(current.head.objectKey, 'state', now), digest: current.head.digest });
    report.applied = true; report.revision = next.revision; return report;
  } finally { await heads.release(owner, token); }
}

// Read-only: retired state versions still inside their recovery window, newest first.
export async function listRecoverable({ heads, objects, owner, now = Date.now() }) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('InvalidRecoveryOwner');
  const sources = (await heads.retired(owner)).filter(item => item.kind === 'state' && item.digest && objectKind(owner, item.objectKey) === 'state' && now < +new Date(item.purgeAfter));
  const result = [];
  for (const item of sources) for (const version of await objects.versions(owner, item.objectKey)) {
    if (!version.deleteMarker) result.push({ objectKey: item.objectKey, versionId: version.versionId, retiredAt: item.retiredAt, purgeAfter: item.purgeAfter });
  }
  return result.sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
}

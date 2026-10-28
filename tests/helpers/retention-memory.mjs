import { randomUUID } from 'node:crypto';
import { entryKey, hash } from '../../stage/retention.mjs';

export function memoryStore(clock) {
  const rows = new Map(), ledgers = new Map(), retiredRows = new Map(), versions = new Map();
  const table = (map, owner) => { if (!map.has(owner)) map.set(owner, new Map()); return map.get(owner); };
  const missing = () => Object.assign(new Error('Missing object'), { name: 'AccessDenied' });
  function push(key, bytes, deleteMarker = false) {
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push({ bytes, deleteMarker, versionId: randomUUID(), lastModified: new Date(clock()).toISOString() });
  }
  const objects = {
    async write(key, text) { push(key, Buffer.from(text)); },
    async writeBytes(key, bytes) { push(key, Buffer.from(bytes)); },
    async read(key) { const value = versions.get(key)?.at(-1); if (!value || value.deleteMarker) throw missing(); return value.bytes.toString(); },
    async readVersion(key, id) { return (await this.readVersionBytes(key, id)).toString(); },
    async readVersionBytes(key, id) { const value = versions.get(key)?.find(value => value.versionId === id); if (!value || value.deleteMarker) throw missing(); return value.bytes; },
    async head(key) { const value = versions.get(key)?.at(-1); if (!value || value.deleteMarker) throw missing(); return { size: value.bytes.length, sha256: hash(value.bytes) }; },
    async remove(key) { push(key, null, true); },
    async purge(key, id) { versions.set(key, (versions.get(key) || []).filter(value => value.versionId !== id)); },
    async versions(owner, exact) {
      return [...versions].filter(([key]) => key.startsWith(`samples/${owner}/`) && (!exact || key === exact)).flatMap(([objectKey, values]) => values.map((value, i) => ({ ...value, objectKey, isLatest: i === values.length - 1 })));
    },
    async downloadUrl(key) { return `https://files.invalid/${key}`; },
    async uploadUrl(key) { return { url: `https://files.invalid/${key}`, headers: {} }; },
  };
  const heads = {
    async get(owner) { return rows.get(owner); },
    async owners() { return [...rows.keys()]; },
    async tombstones(owner) { return [...table(ledgers, owner).values()]; },
    async retired(owner) { return [...table(retiredRows, owner).values()]; },
    async compareAndSwap(owner, revision, next, changes) {
      if ((rows.get(owner)?.revision || 0) !== revision || rows.get(owner)?.maintenanceToken) return false;
      if (changes.candidateEntries.some(entry => table(ledgers, owner).has(entryKey(entry)))) return false;
      if (changes.candidateFiles.some(key => table(retiredRows, owner).has(key))) return false;
      for (const entry of changes.deletions) table(ledgers, owner).set(entryKey(entry), { ...entry, deletedAt: changes.at });
      for (const item of changes.retirements) if (!table(retiredRows, owner).has(item.objectKey)) table(retiredRows, owner).set(item.objectKey, item);
      rows.set(owner, { ...next, maintenanceToken: null }); return true;
    },
    async claim(owner, token) { const row = rows.get(owner); if (!row || row.maintenanceToken) return false; rows.set(owner, { ...row, maintenanceToken: token }); return true; },
    async release(owner, token) { const row = rows.get(owner); if (row?.maintenanceToken === token) rows.set(owner, { ...row, maintenanceToken: null }); },
    async retire(owner, token, item) { if (rows.get(owner)?.maintenanceToken !== token) throw new Error('MaintenanceFenceLost'); if (!table(retiredRows, owner).has(item.objectKey)) table(retiredRows, owner).set(item.objectKey, item); },
    async forgetRetired(owner, token, key) { if (rows.get(owner)?.maintenanceToken !== token) throw new Error('MaintenanceFenceLost'); table(retiredRows, owner).delete(key); },
    async publishRecovery(owner, token, revision, next, previous) { if (rows.get(owner)?.maintenanceToken !== token || rows.get(owner)?.revision !== revision) throw new Error('RecoveryFenceLost'); await this.retire(owner, token, previous); rows.set(owner, { ...next, maintenanceToken: token }); },
  };
  return { heads, objects, rows, ledgers, retiredRows, rawVersions: versions };
}

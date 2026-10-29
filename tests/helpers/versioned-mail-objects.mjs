import { randomUUID } from 'node:crypto';
export function versionedObjects(now = Date.now) {
  const history = new Map();
  const latest = key => history.get(key)?.at(-1);
  const missing = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
  return {
    history,
    async put(key, body) { if (!history.has(key)) history.set(key, []); history.get(key).push({ key, versionId: randomUUID(), bytes: Buffer.from(body), lastModified: new Date(now()).toISOString(), deleteMarker: false }); },
    async getBytes(key) { const row = latest(key); if (!row || row.deleteMarker) throw missing(); return Buffer.from(row.bytes); },
    async get(key) { return (await this.getBytes(key)).toString(); },
    async getRecoverable(key) { const row = [...history.get(key) || []].reverse().find(row => !row.deleteMarker); if (!row) throw missing(); return Buffer.from(row.bytes); },
    async listCurrent(prefix) { return [...history.keys()].filter(key => key.startsWith(prefix) && !latest(key)?.deleteMarker); },
    async remove(key) { if (!history.has(key)) history.set(key, []); history.get(key).push({ key, versionId: randomUUID(), lastModified: new Date(now()).toISOString(), deleteMarker: true }); },
    async versions(prefix) { return [...history].filter(([key]) => key.startsWith(prefix)).flatMap(([, rows]) => rows.map((row, i) => ({ ...row, isLatest: i === rows.length - 1 }))); },
    async removeVersion(key, id) { history.set(key, (history.get(key) || []).filter(row => row.versionId !== id)); if (!history.get(key).length) history.delete(key); },
  };
}

// Capture is a short-lived intake buffer, never a second permanent email archive.
// Expire every version from its own creation, including current versions and failed imports.
export async function cleanupCaptureBuffer({ objects, now = Date.now() }) {
  const deadline = now - 15 * 86400000; let removed = 0;
  for (const row of await objects.versions('capture/')) if (+new Date(row.lastModified) <= deadline) { await objects.removeVersion(row.key, row.versionId); removed++; }
  for (const row of await objects.versions('capture/')) if (+new Date(row.lastModified) <= deadline) throw new Error('ExpiredCaptureVersionRemains');
  return { removed };
}

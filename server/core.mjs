import { randomUUID } from 'node:crypto';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const FOLDERS = ['inbox', 'sent', 'archive', 'trash', 'spam'];
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(ok, message, status = 400) {
  if (!ok) throw new HttpError(status, message);
}
export function address(value) {
  return typeof value === 'string' && value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(value);
}
export function recipients(value, required = false) {
  check(Array.isArray(value) && value.length <= 20, 'Use at most 20 recipients per field.');
  check(!required || value.length > 0, 'Add a recipient.');
  check(value.every(address), 'Enter valid email addresses without display names.');
  return [...new Set(value.map(x => x.toLowerCase()))];
}
export function safeFilename(value) {
  return String(value || 'attachment').replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, '_').slice(0, 180) || 'attachment';
}
export function validateSend(data) {
  check(data && typeof data === 'object', 'Invalid message.');
  check(typeof data.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(data.requestId), 'Invalid request ID.');
  const to = recipients(data.to, true), cc = recipients(data.cc || []), bcc = recipients(data.bcc || []);
  check(to.length + cc.length + bcc.length <= 50, 'Use at most 50 recipients.');
  check(typeof data.subject === 'string' && data.subject.length <= 998 && !/[\r\n]/.test(data.subject), 'Subject is too long or contains a line break.');
  check(typeof data.text === 'string' && Buffer.byteLength(data.text) <= 100_000, 'Message text must be under 100 KB.');
  check(Array.isArray(data.attachments || []) && (data.attachments || []).length <= 10, 'Use at most 10 attachments.');
  if (data.replyToId) check(/^[a-zA-Z0-9_-]{1,160}$/.test(data.replyToId), 'Invalid reply reference.');
  return { ...data, to, cc, bcc, attachments: data.attachments || [] };
}
export function metadata({ id = randomUUID(), folder = 'inbox', date = new Date(), ...rest }) {
  const receivedAt = new Date(date).toISOString();
  return { id, folder, receivedAt, sortKey: `${receivedAt}#${id}`, read: folder === 'sent', ...rest };
}
export function summary(item) {
  const { rawKey, bodyKey, ...view } = item;
  return view;
}
export function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    check(key && typeof key.id === 'string' && FOLDERS.includes(key.folder) && typeof key.sortKey === 'string', 'Invalid page cursor.');
    return { id: key.id, folder: key.folder, sortKey: key.sortKey };
  } catch { throw new HttpError(400, 'Invalid page cursor.'); }
}

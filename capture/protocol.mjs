// Versioned, complete SES request capture. Producers retain SES's existing wire request;
// the inbox reconstructs display MIME and retains this canonical representation too.
export const VERSION = 1;
export const NORMAL_KINDS = new Set(['website_contact', 'member_invitation', 'course_invitation', 'course_assigned', 'due_reminder', 'overdue_reminder', 'weekly_digest', 'marking_waiting', 'notification']);
export const EXCLUDED_KINDS = new Set(['verification', 'signup_code', 'password_reset', 'verification_code']);
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const SOURCE = /^[a-z][a-z0-9-]{1,63}$/;
export const MAX_CAPTURE_BYTES = 48 * 1024 * 1024;
export const keyFor = (source, id, name = 'message.json') => {
  if (!SOURCE.test(source) || !UUID.test(id) || !['message.json', 'result.json'].includes(name)) throw new Error('InvalidCaptureIdentity');
  return `capture/${source}/${id}/${name}`;
};
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new Error('CaptureRequiresBinaryContent');
  return Buffer.from(value).toString('base64');
}
export function serializeRequest(input) {
  if (!input || typeof input.FromEmailAddress !== 'string' || !input.Destination || (!input.Content?.Simple && !input.Content?.Raw) || input.Content?.Template) throw new Error('UnsupportedCaptureRequest');
  const request = structuredClone(input);
  if (request.Content.Raw) request.Content.Raw.Data = bytes(input.Content.Raw.Data);
  for (const [i, file] of (request.Content.Simple?.Attachments || []).entries()) file.RawContent = bytes(input.Content.Simple.Attachments[i].RawContent);
  // JSON is the transport; binary fields above are explicit base64, never Buffer's implicit JSON form.
  const serialized = JSON.parse(JSON.stringify(request));
  if (Buffer.byteLength(JSON.stringify(serialized)) > MAX_CAPTURE_BYTES) throw new Error('CaptureMessageTooLarge');
  return serialized;
}
export function decodeBytes(value) {
  if (typeof value !== 'string' || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('InvalidCaptureEncoding');
  return Buffer.from(value, 'base64');
}
export function decodeRecord(text, source, id) {
  if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) throw new Error('CaptureMessageTooLarge');
  const record = JSON.parse(text);
  if (record.version !== VERSION || record.source !== source || record.id !== id || !NORMAL_KINDS.has(record.kind) || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('InvalidCaptureRecord');
  const request = record.request;
  if (!request?.Destination || !request?.Content || typeof request.FromEmailAddress !== 'string') throw new Error('InvalidCaptureRequest');
  if (request.Content.Raw) decodeBytes(request.Content.Raw.Data);
  else if (!request.Content.Simple || request.Content.Template) throw new Error('UnsupportedCaptureRequest');
  return record;
}

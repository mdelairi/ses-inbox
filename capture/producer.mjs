import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { VERSION, NORMAL_KINDS, EXCLUDED_KINDS, keyFor, serializeRequest, MAX_CAPTURE_BYTES } from './protocol.mjs';
const DEFINITE = new Set(['MessageRejected', 'BadRequestException', 'AccessDeniedException', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException', 'NotFoundException', 'LimitExceededException', 'TooManyRequestsException']);

export function captureWriter({ bucket, region }) {
  const client = new S3Client({ region, maxAttempts: 2 });
  return async (key, body, reserve = false) => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body), ContentType: 'application/json', CacheControl: 'private,no-store', ...(reserve ? { IfNoneMatch: '*' } : {}) }), { abortSignal: AbortSignal.timeout(2500) });
  };
}
// No capture credentials, public ingestion endpoint or read/list permissions. The
// caller supplies a stable attempt id when its own delivery record provides one.
export function createCapturedSender({ source, put, send, now = Date.now, warn = console.warn }) {
  return async ({ kind, input, options, id = randomUUID() }) => {
    if (EXCLUDED_KINDS.has(kind)) return send(new SendEmailCommand(input), options);
    if (!NORMAL_KINDS.has(kind)) throw new Error('CaptureKindRequired');
    const key = keyFor(source, id);
    if ((input.EmailTags || []).some(tag => ['inbox_capture', 'inbox_source'].includes(tag.Name))) throw new Error('ReservedCaptureTag');
    const tagged = { ...input, EmailTags: [...(input.EmailTags || []), { Name: 'inbox_capture', Value: id }, { Name: 'inbox_source', Value: source }] };
    let record;
    try {
      record = { version: VERSION, source, id, kind, createdAt: new Date(now()).toISOString(), request: serializeRequest(tagged) };
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_CAPTURE_BYTES) throw new Error('CaptureMessageTooLarge');
    } catch (cause) { throw Object.assign(new Error(cause.message), { name: 'CaptureBeforeSendError', notSent: true, cause }); }
    try { await put(key, record, true); }
    catch (cause) {
      // No SES call occurs when reservation/capture fails. A duplicate reservation
      // cannot be retried safely without the producer's own durable outcome record.
      throw Object.assign(new Error(cause.name === 'PreconditionFailed' || cause.$metadata?.httpStatusCode === 412 ? 'CaptureAlreadyAttempted' : 'CaptureUnavailable'), { name: 'CaptureBeforeSendError', cause, notSent: cause.name !== 'PreconditionFailed' && cause.$metadata?.httpStatusCode !== 412 });
    }
    async function outcome(state, sesMessageId, errorName) {
      try { await put(keyFor(source, id, 'result.json'), { version: VERSION, source, id, state, sesMessageId: sesMessageId || null, errorName: errorName || null, updatedAt: new Date(now()).toISOString() }); }
      catch { warn(JSON.stringify({ event: 'capture-status-write-failed', source, id })); }
    }
    let result;
    try { result = await send(new SendEmailCommand(tagged), options); }
    catch (error) { await outcome(DEFINITE.has(error.name) ? 'failed' : 'uncertain', null, error.name); throw error; }
    await outcome(result?.MessageId ? 'sent' : 'uncertain', result?.MessageId);
    return result; // Provider acceptance and the caller's existing result handling are preserved.
  };
}

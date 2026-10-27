import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { check, HttpError, FOLDERS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, safeFilename, validateSend, metadata, summary, decodeCursor } from './core.mjs';
import { getMail, putMail, updateMail, listMail, readObject, putObject, headObject, uploadForm, downloadUrl } from './storage.mjs';

// SES sending has no idempotency token. Do not automatically retry a send after a timeout.
const ses = new SESv2Client({ region: process.env.AWS_REGION, maxAttempts: 1 });
const sender = process.env.SENDER_ADDRESS;
const receive = process.env.RECEIVE_ADDRESSES?.split(',') || [];
const json = (statusCode, data) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(data) });

async function send(data, sub) {
  data = validateSend(data);
  const id = data.requestId;
  try {
    const existing = await getMail(id);
    if (existing.status === 'accepted') return { id, status: existing.status };
    throw new HttpError(409, 'This send was already attempted. Check Sent before trying again.');
  } catch (e) { if (e.status !== 404) throw e; }
  let total = 0;
  const files = [];
  for (const file of data.attachments) {
    check(typeof file.key === 'string' && file.key.startsWith(`uploads/${sub}/`) && /^uploads\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}$/.test(file.key), 'Invalid attachment.');
    const { ContentLength } = await headObject(file.key);
    check(ContentLength > 0 && ContentLength <= MAX_FILE_BYTES, 'An attachment exceeds 10 MB.');
    total += ContentLength;
    check(total <= MAX_TOTAL_BYTES, 'Attachments exceed 20 MB in total.');
    files.push({ filename: safeFilename(file.name), content: await readObject(file.key) });
  }
  let inReplyTo;
  if (data.replyToId) {
    const original = await getMail(data.replyToId);
    const body = JSON.parse((await readObject(original.bodyKey)).toString());
    inReplyTo = body.messageId;
  }
  const messageId = `<${id}@${sender.split('@')[1]}>`;
  const raw = await new MailComposer({ from: sender, to: data.to, cc: data.cc, bcc: data.bcc,
    replyTo: receive[0], subject: data.subject, text: data.text, attachments: files,
    messageId, inReplyTo, references: inReplyTo, date: new Date(), disableFileAccess: true, disableUrlAccess: true
  }).compile().build();
  check(raw.length < 40_000_000, 'Encoded email is too large.');
  const bodyKey = `messages/${id}/body.json`, rawKey = `messages/${id}/original.eml`;
  const item = metadata({ id, folder: 'sent', from: sender, to: data.to, cc: data.cc, bcc: data.bcc,
    subject: data.subject || '(No subject)', snippet: data.text.replace(/\s+/g, ' ').slice(0, 150),
    attachmentCount: files.length, bodyKey, rawKey, status: 'sending' });
  try { await putMail(item); } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new HttpError(409, 'This send is already being processed.');
    throw e;
  }
  try {
    const attachments = [];
    for (let i = 0; i < files.length; i++) {
      const key = `messages/${id}/files/${i}`;
      await putObject(key, files[i].content);
      attachments.push({ key, name: files[i].filename, size: files[i].content.length });
    }
    await putObject(bodyKey, JSON.stringify({ text: data.text, attachments, messageId }), 'application/json');
    await putObject(rawKey, raw);
  } catch (e) {
    await updateMail(id, { status: 'failed' });
    throw new HttpError(502, 'Could not archive the message. Nothing was sent. Try again with a new message.');
  }
  let result;
  try {
    result = await ses.send(new SendEmailCommand({ FromEmailAddress: sender,
      Destination: { ToAddresses: data.to, CcAddresses: data.cc, BccAddresses: data.bcc },
      Content: { Raw: { Data: raw } }
    }));
  } catch (e) {
    const rejected = e.$metadata?.httpStatusCode >= 400 && e.$metadata?.httpStatusCode < 500;
    await updateMail(id, { status: rejected ? 'failed' : 'uncertain' });
    throw new HttpError(502, rejected ? 'SES rejected this email. Check your SES verification, sandbox and sending limits.' : 'Send status is uncertain. Check Sent and the recipient before resending.');
  }
  try { await updateMail(id, { status: 'accepted', sesMessageId: result.MessageId }); }
  catch { throw new HttpError(502, 'SES accepted the email, but saving its status failed. Do not resend it.'); }
  return { id, status: 'accepted' };
}

export async function handler(event) {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    check(claims?.sub && claims.token_use === 'access', 'Sign in to continue.', 401);
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    let data;
    if (event.body) {
      check(Buffer.byteLength(event.body) <= 180_000, 'Request is too large.', 413);
      try { data = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body); }
      catch { throw new HttpError(400, 'Invalid JSON.'); }
    }
    if (method === 'GET' && path === '/api/config') return json(200, { sender, receive, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
    if (method === 'GET' && path === '/api/messages') {
      const folder = event.queryStringParameters?.folder || 'inbox';
      check(FOLDERS.includes(folder), 'Unknown folder.');
      const result = await listMail(folder, decodeCursor(event.queryStringParameters?.cursor));
      return json(200, { messages: (result.Items || []).map(summary), cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null });
    }
    if (method === 'POST' && path === '/api/uploads') {
      check(Number.isInteger(data?.size) && data.size > 0 && data.size <= MAX_FILE_BYTES, 'Attachments must be between 1 byte and 10 MB.');
      const key = `uploads/${claims.sub}/${randomUUID()}`;
      return json(200, { key, ...await uploadForm(key) });
    }
    if (method === 'POST' && path === '/api/send') return json(200, await send(data, claims.sub));
    const match = path.match(/^\/api\/messages\/([A-Za-z0-9_-]{1,160})(?:\/(attachments|original)(?:\/(\d+))?)?$/);
    if (match) {
      const [, id, action, index] = match;
      const item = await getMail(id);
      if (method === 'PATCH' && !action) {
        check(data && (data.folder !== undefined || data.read !== undefined), 'No changes supplied.');
        check(data.folder === undefined || FOLDERS.includes(data.folder), 'Unknown folder.');
        check(data.read === undefined || typeof data.read === 'boolean', 'Invalid read state.');
        const patch = {};
        if (data.folder !== undefined) patch.folder = data.folder;
        if (data.read !== undefined) patch.read = data.read;
        return json(200, summary(await updateMail(id, patch)));
      }
      if (method === 'GET') {
        if (action) check(!item.quarantined, 'Downloads are disabled for a virus-flagged message.', 403);
        if (action === 'original') return json(200, { url: await downloadUrl(item.rawKey, `${id}.eml`) });
        const body = JSON.parse((await readObject(item.bodyKey)).toString());
        if (action === 'attachments') {
          const file = body.attachments?.[Number(index)];
          check(index !== undefined && file, 'Attachment not found.', 404);
          return json(200, { url: await downloadUrl(file.key, file.name) });
        }
        // Storage keys and BCC envelope routing are never needed to render a message.
        return json(200, { ...summary(item), text: body.text,
          attachments: (body.attachments || []).map(({ name, size }, i) => ({ name, size, index: i })) });
      }
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (!e.status) console.error('API error', { name: e.name, requestId: event.requestContext?.requestId });
    return json(e.status || 500, { error: e.status ? e.message : 'Something went wrong. Please try again.' });
  }
}

import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

export const MAX_RAW_BYTES = 40 * 1024 * 1024; // SES receiving limit
export const MAX_ATTACHMENTS = 100;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const messageIds = value => list(value).flatMap(item => String(item).match(/<[^<>\s]+>/g) || []);
function addresses(header) {
  return list(header).flatMap(item => item?.value || []).flatMap(function flat(item) { return item.group ? item.group.flatMap(flat) : [item]; })
    .filter(item => item.address).map(item => ({ name: String(item.name || '').slice(0, 200), address: item.address.toLowerCase() }));
}

// Parses untrusted raw MIME into a bounded record. HTML is kept as received;
// the client sanitizes it and renders it in a sandboxed frame.
export async function parseMessage(raw) {
  if (raw.length > MAX_RAW_BYTES) throw Object.assign(new Error('MessageTooLarge'), { permanent: true });
  const parsed = await simpleParser(raw, { skipImageLinks: true, keepCidLinks: true, skipTextToHtml: true });
  const attachments = parsed.attachments.slice(0, MAX_ATTACHMENTS).map(part => ({
    filename: String(part.filename || 'attachment').slice(0, 255), contentType: String(part.contentType || 'application/octet-stream').slice(0, 255),
    size: part.size ?? part.content.length, cid: part.cid ? String(part.cid).slice(0, 255) : null, inline: Boolean(part.cid && (part.related || part.contentDisposition === 'inline')),
    sha256: sha256(part.content), content: part.content,
  }));
  const from = addresses(parsed.from)[0] || { name: '', address: '' };
  const to = addresses(parsed.to), cc = addresses(parsed.cc), replyTo = addresses(parsed.replyTo);
  const references = [...new Set([...messageIds(parsed.references), ...messageIds(parsed.inReplyTo)])].slice(-50);
  // mailparser substitutes "now" for an unparseable Date header; read the original line instead.
  const dateLine = parsed.headerLines.find(line => line.key === 'date')?.line.replace(/^date:\s*/i, '');
  const sent = dateLine ? new Date(dateLine) : null;
  return {
    rfcMessageId: messageIds(parsed.messageId)[0] || null, inReplyTo: messageIds(parsed.inReplyTo)[0] || null, references,
    subject: String(parsed.subject || '').slice(0, 2000), from, to, cc, replyTo,
    sentAt: sent && !Number.isNaN(+sent) ? sent.toISOString() : null,
    text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : '',
    attachments, attachmentsOmitted: Math.max(0, parsed.attachments.length - MAX_ATTACHMENTS),
    // Set on copies this app forwarded; a copy that comes back is never forwarded again.
    forwarded: parsed.headers.has('x-inbox-forwarded'),
  };
}

// Search fields: one section per address so phrases cannot bridge recipients.
export function searchFields(message) {
  const person = item => `${item.name} ${item.address}`.trim();
  return { sender: [person(message.from)], recipient: [...message.to, ...message.cc].map(person), subject: [message.subject], body: [message.text] };
}

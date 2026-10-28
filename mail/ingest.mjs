import { createHash } from 'node:crypto';
import { parseMessage, searchFields } from './parse.mjs';
import { positions, TOKENIZER_VERSION } from './text.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const rfcHash = id => sha256(String(id).toLowerCase());
const failed = verdict => verdict?.status === 'FAIL';

// Stores body and parts at deterministic keys, so a retried attempt overwrites rather than duplicates.
export async function storeMessage({ objects, domainId, messageId, parsed, raw, extra = {} }) {
  const prefix = `mail/${domainId}/${messageId}`, parts = [];
  for (const [index, part] of parsed.attachments.entries()) {
    const key = `${prefix}/parts/${index}`;
    await objects.put(key, part.content, part.contentType);
    parts.push({ index, key, filename: part.filename, contentType: part.contentType, size: part.size, sha256: part.sha256, cid: part.cid, inline: part.inline });
  }
  await objects.put(`${prefix}/body.json`, JSON.stringify({ text: parsed.text, html: parsed.html }), 'application/json');
  const manifestKey = `${prefix}/manifest.json`;
  await objects.put(manifestKey, JSON.stringify({ version: 1, raw, body: `${prefix}/body.json`, parts, attachmentsOmitted: parsed.attachmentsOmitted, rfcMessageId: parsed.rfcMessageId, references: parsed.references, replyTo: parsed.replyTo, ...extra }), 'application/json');
  return { manifestKey, parts };
}

// Accepts an SES "Received" notification for an S3 receipt action. Routing uses the
// SES envelope recipients, never visible To/Cc headers.
export async function ingestNotification({ notification, repo, objects, bucket, environment = 'production', now = Date.now }) {
  const { receipt, mail } = notification || {};
  if (notification?.notificationType !== 'Received' || receipt?.action?.type !== 'S3') throw Object.assign(new Error('UnsupportedNotification'), { permanent: true });
  if (receipt.action.bucketName !== bucket || !/^incoming\/[\w!.*'()/-]+$/.test(receipt.action.objectKey)) throw Object.assign(new Error('UnexpectedReceiptObject'), { permanent: true });
  const recipients = [...new Set((receipt.recipients || []).map(address => String(address).toLowerCase()))];
  const aliases = (await repo.aliasesForAddresses(recipients)).filter(alias => alias.receiveEnabled);
  if (!aliases.length) return { unrouted: true, results: [] };
  const domains = new Map();
  for (const alias of aliases) domains.set(alias.domainId, [...(domains.get(alias.domainId) || []), alias.aliasId]);

  const raw = await objects.getRaw(bucket, receipt.action.objectKey);
  let parsed, parseError;
  try { parsed = await parseMessage(raw); } catch (error) { parseError = error; }
  const results = [];
  for (const [domainId, aliasIds] of domains) {
    const receiptKey = sha256(`${mail.messageId}\n${receipt.action.objectKey}\n${domainId}`);
    const claim = await repo.claimReceipt({ domainId, receiptKey, now: now() });
    if (claim.status !== 'claimed') { results.push({ domainId, status: claim.status }); continue; }
    if (parseError) {
      // Parsing is deterministic, so retrying cannot help. Keep the raw object for repair.
      await repo.failReceipt({ domainId, receiptKey, token: claim.token, error: parseError.message });
      results.push({ domainId, status: 'failed' }); continue;
    }
    const { messageId, generation } = claim;
    const quarantined = failed(receipt.virusVerdict);
    // incoming/ is a short-lived intake buffer; the filed copy lives and dies with the message.
    const rawKey = `mail/${domainId}/${messageId}/raw.eml`;
    await objects.put(rawKey, raw, 'message/rfc822');
    const { manifestKey, parts } = await storeMessage({ objects, domainId, messageId, parsed, raw: { bucket, key: rawKey } });
    const threadId = await repo.threadFor(domainId, parsed.references.map(rfcHash)) || messageId;
    const index = positions(searchFields(parsed));
    await repo.insertPositions({ domainId, messageId, generation, rows: index.rows });
    const receivedAt = new Date(Date.parse(mail.timestamp) || now()).toISOString();
    const message = {
      domainId, messageId, threadId, receivedAt, sentAt: parsed.sentAt, subject: parsed.subject, senderName: parsed.from.name, senderAddress: parsed.from.address,
      recipients: { to: parsed.to, cc: parsed.cc }, snippet: parsed.text.replace(/\s+/g, ' ').trim().slice(0, 200), hasAttachments: parts.some(part => !part.inline),
      source: 'manual', environment, verdicts: Object.fromEntries(['spam', 'virus', 'spf', 'dkim', 'dmarc'].map(name => [name, receipt[`${name}Verdict`]?.status || 'NONE'])),
      quarantined, manifestKey, generation, searchPartial: index.partial, tokenizerVersion: TOKENIZER_VERSION,
    };
    const folder = quarantined || failed(receipt.spamVerdict) ? 'spam' : 'inbox';
    const { delivered } = await repo.publish({ receipt: { key: receiptKey, token: claim.token }, message, rfcHash: parsed.rfcMessageId && rfcHash(parsed.rfcMessageId), aliasIds, folder });
    results.push({ domainId, status: 'published', messageId, threadId, folder, delivered });
  }
  return { unrouted: false, results };
}

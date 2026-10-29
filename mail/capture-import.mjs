import { createHash, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { decodeRecord, decodeBytes, keyFor, UUID } from '../capture/protocol.mjs';
import { captureSources } from './capture-sources.mjs';
import { parseMessage, searchFields } from './parse.mjs';
import { positions, TOKENIZER_VERSION } from './text.mjs';
import { createRepository, transaction } from './repository.mjs';
import { createSender, SEND_STATE_RANK } from './send.mjs';
import { rfcHash, storeMessage } from './ingest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const captureAttemptId = (source, id) => { const h = hash(`capture-attempt:${source}:${id}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const receiptKey = (source, id) => hash(`capture:${source}:${id}`);
const absent = error => error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
const person = address => String(address || '').toLowerCase();

async function displayMime(record) {
  const request = record.request;
  if (request.Content.Raw) return decodeBytes(request.Content.Raw.Data);
  const simple = request.Content.Simple, recipients = request.Destination;
  for (const field of ['ToAddresses', 'CcAddresses', 'BccAddresses']) if (recipients[field] && (!Array.isArray(recipients[field]) || recipients[field].some(address => typeof address !== 'string'))) throw new Error('InvalidCaptureRecipients');
  const headers = Object.fromEntries((simple.Headers || []).map(header => [header.Name, header.Value]));
  return new MailComposer({ from: request.FromEmailAddress, to: recipients.ToAddresses, cc: recipients.CcAddresses,
    bcc: recipients.BccAddresses, replyTo: request.ReplyToAddresses, subject: simple.Subject?.Data || '', text: simple.Body?.Text?.Data || '', html: simple.Body?.Html?.Data || undefined,
    headers, date: new Date(record.createdAt), messageId: `<capture-${record.id}@${record.source}.invalid>`,
    attachments: (simple.Attachments || []).map(file => ({ filename: file.FileName, content: decodeBytes(file.RawContent), contentType: file.ContentType,
      contentDisposition: file.ContentDisposition === 'INLINE' ? 'inline' : 'attachment', ...(file.ContentId ? { cid: file.ContentId } : {}) })),
    disableFileAccess: true, disableUrlAccess: true }).compile().build();
}

export function createCaptureImporter({ pool, objects, captureObjects, bucket, sources = captureSources, now = Date.now }) {
  const repo = createRepository(pool), sender = createSender({ pool, objects, ses: {}, bucket, now });
  async function sourceScope(source, id) {
    if (!UUID.test(id) || !sources[source]) throw new Error('UnknownCaptureSource');
    const trusted = sources[source];
    const { rows: [domain] } = await pool.query('SELECT domain_id FROM mail.domains WHERE name=$1', [trusted.domain]);
    if (!domain) throw new Error('CaptureDomainNotConfigured');
    return { trusted, domainId: domain.domain_id, attemptId: captureAttemptId(source, id) };
  }
  async function outcome(source, id, scope) {
    let result;
    try { result = JSON.parse(await captureObjects.get(keyFor(source, id, 'result.json'))); }
    catch (error) { if (absent(error)) return; throw error; }
    if (result.version !== 1 || result.source !== source || result.id !== id || !['sent', 'failed', 'uncertain'].includes(result.state) || (result.sesMessageId !== null && (typeof result.sesMessageId !== 'string' || result.sesMessageId.length > 128))) throw new Error('InvalidCaptureOutcome');
    for (let i = 0; i < 4; i++) {
      const { rows: [row] } = await pool.query('SELECT state, ses_message_id, revision FROM mail.send_attempts WHERE domain_id=$1 AND attempt_id=$2', [scope.domainId, scope.attemptId]);
      if (!row) return;
      if (row.ses_message_id && result.sesMessageId && row.ses_message_id !== result.sesMessageId) throw new Error('CaptureProviderIdConflict');
      if (SEND_STATE_RANK[row.state] > SEND_STATE_RANK[result.state]) return;
      const detail = result.state === 'failed' ? 'The producer reported a definite send failure.' : result.state === 'uncertain' ? 'The producer could not confirm whether SES accepted this email.' : null;
      const changed = await pool.query('UPDATE mail.send_attempts SET state=$3, ses_message_id=$4, detail=$5, updated_at=$6, revision=revision+1 WHERE domain_id=$1 AND attempt_id=$2 AND revision=$7',
        [scope.domainId, scope.attemptId, result.state, result.sesMessageId || row.ses_message_id, detail, new Date(now()).toISOString(), row.revision]);
      if (changed.rowCount) return;
    }
    throw new Error('CaptureOutcomeConflict');
  }
  async function ingest(source, id) {
    const scope = await sourceScope(source, id), claim = await repo.claimReceipt({ domainId: scope.domainId, receiptKey: receiptKey(source, id), now: now() });
    if (claim.status === 'busy') throw new Error('CaptureImportBusy');
    if (claim.status === 'failed') throw new Error('CaptureImportFailed');
    if (claim.status === 'duplicate') {
      const exists = await pool.query('SELECT 1 FROM mail.messages WHERE domain_id=$1 AND message_id=$2', [scope.domainId, claim.messageId]);
      if (!exists.rowCount) {
        // Reject a replay without re-reading/re-filing its content, and remove the
        // replay's private intake versions so deletion cannot restart retention.
        for (const row of await captureObjects.versions(`capture/${source}/${id}/`)) await captureObjects.removeVersion(row.key, row.versionId);
        return { deleted: true, messageId: claim.messageId };
      }
      await outcome(source, id, scope);
      return { duplicate: true, messageId: claim.messageId, ...scope };
    }
    const record = decodeRecord(await captureObjects.get(keyFor(source, id)), source, id);
    if (!scope.trusted.kinds.includes(record.kind)) throw new Error('CaptureKindNotAllowed');
    const raw = await displayMime(record), parsed = await parseMessage(raw), from = person(parsed.from.address);
    if ((scope.trusted.senders && !scope.trusted.senders.includes(from)) || (scope.trusted.senderDomain && !from.endsWith(`@${scope.trusted.senderDomain}`))) throw new Error('CaptureSenderNotAllowed');
    const { rows: [existing] } = await pool.query('SELECT domain_id,alias_id FROM mail.aliases WHERE address=$1', [from]);
    let aliasId = existing?.alias_id;
    if (existing && existing.domain_id !== scope.domainId) throw new Error('CaptureAliasDomainMismatch');
    if (!existing) {
      aliasId = randomUUID();
      await pool.query('INSERT INTO mail.aliases(domain_id,alias_id,address,display_name,receive_enabled,send_enabled,is_default,signature,revision) VALUES($1,$2,$3,$4,false,false,false,$5,1) ON CONFLICT DO NOTHING', [scope.domainId, aliasId, from, parsed.from.name || from, '']);
      const { rows: [created] } = await pool.query('SELECT alias_id FROM mail.aliases WHERE domain_id=$1 AND address=$2', [scope.domainId, from]); aliasId = created.alias_id;
    }
    const prefix = `mail/${scope.domainId}/${claim.messageId}`, rawKey = `${prefix}/raw.eml`, producerRecord = `${prefix}/producer.json`;
    await objects.put(rawKey, raw, 'message/rfc822');
    await objects.put(producerRecord, JSON.stringify(record), 'application/json');
    const bcc = (record.request.Destination.BccAddresses || []).map(person);
    const { manifestKey, parts } = await storeMessage({ objects, domainId: scope.domainId, messageId: claim.messageId, parsed, raw: { bucket, key: rawKey }, extra: {
      bcc, producerRecord, capture: { source, id, kind: record.kind, representation: record.request.Content.Raw ? 'original-mime' : 'ses-v2-request' },
    } });
    const index = positions(searchFields(parsed));
    await repo.insertPositions({ domainId: scope.domainId, messageId: claim.messageId, generation: claim.generation, rows: index.rows });
    const threadId = await repo.threadFor(scope.domainId, parsed.references.map(rfcHash)) || claim.messageId;
    await repo.publish({ receipt: { key: receiptKey(source, id), token: claim.token }, message: {
      domainId: scope.domainId, messageId: claim.messageId, threadId, receivedAt: record.createdAt, sentAt: parsed.sentAt || record.createdAt,
      subject: parsed.subject, senderName: parsed.from.name, senderAddress: from, recipients: { to: parsed.to, cc: parsed.cc, bcc: bcc.map(address => ({ name: '', address })) }, snippet: parsed.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      hasAttachments: parts.some(file => !file.inline), source: 'automated', environment: scope.trusted.environment, verdicts: {}, quarantined: false, manifestKey,
      generation: claim.generation, searchPartial: index.partial, tokenizerVersion: TOKENIZER_VERSION,
    }, rfcHash: parsed.rfcMessageId && rfcHash(parsed.rfcMessageId), aliasIds: [aliasId], folder: 'sent', read: true, sendAttempt: { id: scope.attemptId, aliasId } });
    await outcome(source, id, scope);
    return { published: true, messageId: claim.messageId, ...scope };
  }
  return {
    ingest,
    async recordEvent(event, topicArn) {
      const source = event.mail?.tags?.inbox_source?.[0], id = event.mail?.tags?.inbox_capture?.[0];
      if (!source || !id) return { ignored: true };
      const scope = await sourceScope(source, id);
      if (!scope.trusted.eventTopicArn || topicArn !== scope.trusted.eventTopicArn || event.mail?.sendingAccountId !== scope.trusted.accountId || event.mail?.tags?.['ses:configuration-set']?.[0] !== scope.trusted.configurationSet) throw new Error('UntrustedCaptureFeedback');
      const imported = await ingest(source, id);
      if (imported.deleted) return { deleted: true };
      const result = await sender.recordEvent(event, scope);
      const rfcId = event.mail?.commonHeaders?.messageId;
      if (typeof rfcId === 'string' && /^<[^<>\s]+>$/.test(rfcId)) {
        const { rows: [message] } = await pool.query('SELECT thread_id FROM mail.messages WHERE domain_id=$1 AND message_id=$2', [scope.domainId, imported.messageId]);
        if (message) await transaction(pool, client => client.query('INSERT INTO mail.message_ids(domain_id,rfc_hash,message_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope.domainId, rfcHash(rfcId), imported.messageId, message.thread_id]));
      }
      return result;
    },
  };
}

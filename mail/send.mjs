import { createHash, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { parseMessage, searchFields } from './parse.mjs';
import { positions, TOKENIZER_VERSION } from './text.mjs';
import { rfcHash, storeMessage } from './ingest.mjs';
import { createRepository, transaction } from './repository.mjs';

export const MAX_RECIPIENTS = 50;
export const MAX_SEND_BYTES = 40 * 1024 * 1024; // SES v2 raw message limit
const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value || '') ? value : fail('Invalid identifier');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Rejections SES reports definitively; anything else (timeouts, 5xx) has an unknown outcome.
const DEFINITE = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException', 'BadRequestException', 'NotFoundException', 'LimitExceededException', 'TooManyRequestsException']);
// Final state wins over interim ones; a late DeliveryDelay never downgrades a delivery.
export const SEND_STATE_RANK = { sending: 0, sent: 1, delayed: 2, delivered: 3, bounced: 4, complained: 4, rejected: 4, failed: 4, uncertain: 1 };
const EVENT_STATES = { Send: 'sent', Delivery: 'delivered', Bounce: 'bounced', Complaint: 'complained', Reject: 'rejected', DeliveryDelay: 'delayed', RenderingFailure: 'failed' };

function recipients(list) {
  const values = (Array.isArray(list) ? list : []).map(item => String(item).trim().toLowerCase()).filter(Boolean);
  for (const value of values) if (!ADDRESS.test(value) || value.length > 254) fail(`Check the address ${value}`);
  return [...new Set(values)];
}

export function createSender({ pool, objects, ses, mailbox, bucket, configurationSet, environment = 'production', now = Date.now }) {
  const repo = createRepository(pool);
  return {
    // attemptId is created by the client per send action; repeating it never sends twice.
    async send({ mailbox: address, attemptId, to, cc, bcc, subject = '', text = '', html = '', attachments = [], replyToId }) {
      const alias = await mailbox.alias(address);
      if (!alias.sendEnabled) fail('This address cannot send mail.', 403);
      uuid(attemptId);
      const { rows: [previous] } = await pool.query('SELECT message_id, state FROM mail.send_attempts WHERE domain_id=$1 AND attempt_id=$2', [alias.domainId, attemptId]);
      if (previous) return { attemptId, messageId: previous.message_id, state: previous.state, duplicate: true };
      const list = { to: recipients(to), cc: recipients(cc), bcc: recipients(bcc) };
      const total = list.to.length + list.cc.length + list.bcc.length;
      if (!total) fail('Add at least one recipient.');
      if (total > MAX_RECIPIENTS) fail(`Send to at most ${MAX_RECIPIENTS} recipients.`);
      if (String(subject).length > 998 || /[\r\n]/.test(subject)) fail('Shorten the subject to one line.');

      const files = [];
      for (const file of attachments) {
        if (typeof file?.key !== 'string' || !file.key.startsWith(`uploads/${alias.domainId}/`) || file.key.includes('..')) fail('Attachment upload is missing.');
        const content = await objects.getBytes(file.key);
        if (content.length !== file.size || sha256(content) !== file.sha256) fail('An attachment upload is incomplete.');
        files.push({ filename: String(file.name || 'attachment').slice(0, 255), content, contentType: String(file.type || 'application/octet-stream'), ...(file.inline && file.cid ? { cid: String(file.cid) } : {}) });
      }

      let threadId, inReplyTo, references = [];
      if (replyToId) {
        const { rows: [original] } = await pool.query('SELECT m.thread_id, m.object_manifest_key FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id WHERE e.domain_id=$1 AND e.alias_id=$2 AND e.message_id=$3',
          [alias.domainId, alias.aliasId, uuid(replyToId)]);
        if (!original) fail('The original message is no longer available.', 404);
        const manifest = JSON.parse(await objects.get(original.object_manifest_key));
        threadId = original.thread_id;
        if (manifest.rfcMessageId) { inReplyTo = manifest.rfcMessageId; references = [...(manifest.references || []), manifest.rfcMessageId].slice(-20); }
      }

      const messageId = randomUUID(), sentAt = new Date(now()).toISOString();
      threadId ||= messageId;
      const raw = await new MailComposer({ from: { name: alias.displayName, address: alias.address }, ...list, subject, text, html: html || undefined, attachments: files,
        messageId: `<${messageId}@${alias.domain}>`, inReplyTo, references, date: new Date(sentAt), disableFileAccess: true, disableUrlAccess: true }).compile().build();
      if (raw.length > MAX_SEND_BYTES) fail('This message is too large to send.', 413);

      // The Sent copy is the exact MIME handed to SES, stored and indexed like received mail.
      const rawKey = `mail/${alias.domainId}/${messageId}/raw.eml`;
      await objects.put(rawKey, raw, 'message/rfc822');
      const parsed = await parseMessage(raw);
      const { manifestKey, parts } = await storeMessage({ objects, domainId: alias.domainId, messageId, parsed, raw: { bucket, key: rawKey }, extra: { bcc: list.bcc } });
      const index = positions(searchFields(parsed));
      await repo.insertPositions({ domainId: alias.domainId, messageId, generation: 1, rows: index.rows });
      await transaction(pool, async client => {
        await client.query('INSERT INTO mail.send_attempts(domain_id,attempt_id,alias_id,message_id,state,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,1)', [alias.domainId, attemptId, alias.aliasId, messageId, 'sending', sentAt]);
        await client.query(`INSERT INTO mail.messages(domain_id,message_id,thread_id,received_at,sent_at,subject,sender_name,sender_address,recipients_json,snippet,has_attachments,source,environment,verdicts_json,quarantined,object_manifest_key,search_generation,search_partial,tokenizer_version,revision)
          VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,'manual',$11,'{}',false,$12,1,$13,$14,1)`,
        [alias.domainId, messageId, threadId, sentAt, parsed.subject, alias.displayName, alias.address, JSON.stringify({ to: parsed.to, cc: parsed.cc, bcc: list.bcc.map(item => ({ name: '', address: item })) }),
          parsed.text.replace(/\s+/g, ' ').trim().slice(0, 200), parts.some(part => !part.inline), environment, manifestKey, index.partial, TOKENIZER_VERSION]);
        await client.query('INSERT INTO mail.message_ids(domain_id,rfc_hash,message_id,thread_id) VALUES($1,$2,$3,$4)', [alias.domainId, rfcHash(parsed.rfcMessageId), messageId, threadId]);
        await client.query("INSERT INTO mail.mailbox_entries(domain_id,alias_id,message_id,thread_id,folder,is_read,received_at,revision) VALUES($1,$2,$3,$4,'sent',true,$5,1)", [alias.domainId, alias.aliasId, messageId, threadId, sentAt]);
      });

      let state, sesMessageId = null, detail = null;
      try {
        sesMessageId = (await ses.sendRaw({ from: alias.address, destination: { ToAddresses: list.to, CcAddresses: list.cc, BccAddresses: list.bcc }, raw, configurationSet })).messageId;
        state = 'sent';
      } catch (error) {
        state = DEFINITE.has(error.name) ? 'failed' : 'uncertain';
        detail = state === 'failed' ? String(error.message || error.name).slice(0, 500) : 'SES did not confirm whether this message was accepted. Check Sent before sending again.';
      }
      await pool.query('UPDATE mail.send_attempts SET state=$3, ses_message_id=$4, detail=$5, updated_at=$6, revision=revision+1 WHERE domain_id=$1 AND attempt_id=$2', [alias.domainId, attemptId, state, sesMessageId, detail, new Date(now()).toISOString()]);
      return { attemptId, messageId, threadId, state, detail };
    },

    // SES configuration-set events (via SNS). Unknown message ids are ignored: other senders share events.
    async recordEvent(event, scope) {
      const state = EVENT_STATES[event?.eventType];
      const sesMessageId = event?.mail?.messageId;
      if (!state || !sesMessageId) return { ignored: true };
      const detail = event.bounce ? `${event.bounce.bounceType}/${event.bounce.bounceSubType}: ${(event.bounce.bouncedRecipients || []).map(item => item.emailAddress).join(', ')}`
        : event.complaint ? `Complaint from ${(event.complaint.complainedRecipients || []).map(item => item.emailAddress).join(', ')}`
        : event.reject?.reason || event.failure?.errorMessage || null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const { rows: [row] } = scope
          ? await pool.query('SELECT domain_id, attempt_id, state, revision, ses_message_id FROM mail.send_attempts WHERE domain_id=$1 AND attempt_id=$2', [scope.domainId, scope.attemptId])
          : await pool.query('SELECT domain_id, attempt_id, state, revision, ses_message_id FROM mail.send_attempts WHERE ses_message_id=$1', [sesMessageId]);
        if (!row) return { ignored: true };
        if (row.ses_message_id && row.ses_message_id !== sesMessageId) throw new Error('CaptureProviderIdConflict');
        if (scope && !row.ses_message_id) {
          const result = await pool.query('UPDATE mail.send_attempts SET ses_message_id=$3, revision=revision+1 WHERE domain_id=$1 AND attempt_id=$2 AND revision=$4', [row.domain_id, row.attempt_id, sesMessageId, row.revision]);
          if (!result.rowCount) continue;
          row.revision++;
        }
        if (SEND_STATE_RANK[state] < SEND_STATE_RANK[row.state] || (SEND_STATE_RANK[state] === SEND_STATE_RANK[row.state] && state === row.state)) return { state: row.state };
        const { rowCount } = await pool.query('UPDATE mail.send_attempts SET state=$3, detail=$4, updated_at=$5, revision=revision+1 WHERE domain_id=$1 AND attempt_id=$2 AND revision=$6',
          [row.domain_id, row.attempt_id, state, detail ? detail.slice(0, 500) : null, new Date(now()).toISOString(), row.revision]);
        if (rowCount) return { state };
      }
      throw Object.assign(new Error('SendEventConflict'), { retryable: true });
    },
  };
}

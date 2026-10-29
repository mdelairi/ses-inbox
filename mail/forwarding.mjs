import { createHash } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { ADDRESS, DEFINITE, MAX_SEND_BYTES } from './send.mjs';
import { transaction } from './repository.mjs';

export const MAX_FORWARD_TARGETS = 3;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const placeholders = (values, offset) => values.map((_, i) => `$${i + 1 + offset}`).join(',');
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Deterministic per message, address and target, so a redelivered notification finds the earlier attempt.
export const forwardAttemptId = (messageId, aliasId, target) => { const h = sha256(`forward:${messageId}:${aliasId}:${target}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// Per-address forwarding of new Inbox mail. The copy is sent from the receiving address
// (SES only sends from our verified domains) with Reply-To set to the original sender.
export function createForwarding({ pool, ses, mailbox, configurationSet, now = Date.now }) {
  return {
    async rules({ mailbox: address }) {
      const alias = await mailbox.alias(address);
      const { rows } = await pool.query('SELECT target FROM mail.forward_rules WHERE domain_id=$1 AND alias_id=$2 ORDER BY target', [alias.domainId, alias.aliasId]);
      return { mailbox: alias.address, targets: rows.map(row => row.target) };
    },

    async save({ mailbox: address, targets }) {
      const alias = await mailbox.alias(address);
      if (!alias.receiveEnabled) fail('This address does not receive mail.', 403);
      if (!Array.isArray(targets)) fail('Choose forwarding addresses.');
      const list = [...new Set(targets.map(item => String(item).trim().toLowerCase()).filter(Boolean))].sort();
      if (list.length > MAX_FORWARD_TARGETS) fail(`Forward to at most ${MAX_FORWARD_TARGETS} addresses.`);
      for (const value of list) if (!ADDRESS.test(value) || value.length > 254) fail(`Check the address ${value}`);
      // An inbox address would receive its own copy again: a mail loop.
      if (list.length && (await pool.query(`SELECT 1 FROM mail.aliases WHERE address IN (${placeholders(list, 0)})`, list)).rowCount) fail('Forward to an address outside this inbox.');
      await transaction(pool, async client => {
        await client.query('DELETE FROM mail.forward_rules WHERE domain_id=$1 AND alias_id=$2', [alias.domainId, alias.aliasId]);
        for (const target of list) await client.query('INSERT INTO mail.forward_rules(domain_id,alias_id,target,created_at) VALUES($1,$2,$3,$4)', [alias.domainId, alias.aliasId, target, new Date(now()).toISOString()]);
      });
      return { mailbox: alias.address, targets: list };
    },

    // The worker calls this once a message is readable in Inbox. At most once per target:
    // the attempt row is written first, and an SES failure is recorded rather than retried.
    async forward({ domainId, messageId, aliasIds, parsed }) {
      if (parsed.forwarded || !aliasIds.length) return [];
      const { rows } = await pool.query(`SELECT r.alias_id, r.target, a.address, a.display_name, a.receive_enabled, d.name AS domain FROM mail.forward_rules r JOIN mail.aliases a ON a.domain_id=r.domain_id AND a.alias_id=r.alias_id
        JOIN mail.domains d ON d.domain_id=r.domain_id WHERE r.domain_id=$1 AND r.alias_id IN (${placeholders(aliasIds, 1)}) ORDER BY a.address, r.target`, [domainId, ...aliasIds]);
      const results = [];
      for (const row of rows.filter(item => item.receive_enabled)) {
        const attemptId = forwardAttemptId(messageId, row.alias_id, row.target), at = new Date(now()).toISOString();
        const { rowCount } = await pool.query("INSERT INTO mail.forward_attempts(domain_id,attempt_id,alias_id,message_id,target,state,updated_at,revision) VALUES($1,$2,$3,$4,$5,'sending',$6,1) ON CONFLICT DO NOTHING",
          [domainId, attemptId, row.alias_id, messageId, row.target, at]);
        if (!rowCount) { results.push({ target: row.target, state: 'duplicate' }); continue; }
        const sender = parsed.from.name || parsed.from.address || 'Unknown sender';
        const raw = await new MailComposer({ from: { name: `${sender} via ${row.address}`, address: row.address }, to: row.target,
          replyTo: parsed.replyTo.length ? parsed.replyTo : parsed.from.address ? [parsed.from] : undefined, subject: parsed.subject, text: parsed.text, html: parsed.html || undefined,
          attachments: parsed.attachments.map(part => ({ filename: part.filename, content: part.content, contentType: part.contentType, contentDisposition: part.inline ? 'inline' : 'attachment', ...(part.cid ? { cid: part.cid } : {}) })),
          headers: { 'X-Inbox-Forwarded': row.address }, messageId: `<${attemptId}@${row.domain}>`, date: new Date(at), disableFileAccess: true, disableUrlAccess: true }).compile().build();
        let state, sesMessageId = null, detail = null;
        if (raw.length > MAX_SEND_BYTES) { state = 'failed'; detail = 'Too large to forward.'; }
        else {
          try { sesMessageId = (await ses.sendRaw({ from: row.address, destination: { ToAddresses: [row.target] }, raw, configurationSet })).messageId; state = 'sent'; }
          catch (error) { state = DEFINITE.has(error.name) ? 'failed' : 'uncertain'; detail = String(error.name).slice(0, 200); }
        }
        await pool.query('UPDATE mail.forward_attempts SET state=$3, ses_message_id=$4, detail=$5, updated_at=$6, revision=revision+1 WHERE domain_id=$1 AND attempt_id=$2', [domainId, attemptId, state, sesMessageId, detail, new Date(now()).toISOString()]);
        results.push({ target: row.target, state });
      }
      return results;
    },
  };
}

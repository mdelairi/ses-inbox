import { simpleParser } from 'mailparser';
import { metadata, safeFilename } from './core.mjs';
import { getMail, readObject, putObject, putMail } from './storage.mjs';

export async function handler(event) {
  for (const record of event.Records || []) {
    const ses = record.ses;
    if (!ses?.mail?.messageId) throw new Error('Expected an SES receipt event.');
    const id = ses.mail.messageId;
    try { await getMail(id); continue; } catch (e) { if (e.status !== 404) throw e; }
    const rawKey = `raw/${id}`;
    const mail = await simpleParser(await readObject(rawKey), { skipImageLinks: true, skipTextToHtml: true });
    const virus = ses.receipt?.virusVerdict?.status;
    const spam = ses.receipt?.spamVerdict?.status;
    const quarantined = virus === 'FAIL';
    const folder = quarantined || spam === 'FAIL' ? 'spam' : 'inbox';
    const files = [];
    // Virus-flagged content remains in raw storage; it is never exposed for download.
    if (!quarantined) {
      for (let i = 0; i < mail.attachments.length; i++) {
        const file = mail.attachments[i];
        const name = safeFilename(file.filename);
        const key = `messages/${id}/files/${i}`;
        await putObject(key, file.content);
        files.push({ name, size: file.size, key });
      }
    }
    const text = String(mail.text || '').slice(0, 1_000_000);
    const bodyKey = `messages/${id}/body.json`;
    await putObject(bodyKey, JSON.stringify({ text, attachments: files, messageId: mail.messageId }), 'application/json');
    const item = metadata({ id, folder, date: ses.mail.timestamp,
      from: mail.from?.text || ses.mail.source || '(Unknown sender)',
      replyTo: mail.replyTo?.value?.[0]?.address || mail.from?.value?.[0]?.address || ses.mail.source,
      to: (mail.to?.value || []).map(x => x.address), cc: (mail.cc?.value || []).map(x => x.address),
      envelopeTo: ses.receipt.recipients || ses.mail.destination || [],
      subject: String(mail.subject || '(No subject)').slice(0, 998), snippet: text.replace(/\s+/g, ' ').slice(0, 150),
      attachmentCount: files.length, bodyKey, rawKey, quarantined,
      verdicts: { spam: spam || 'UNKNOWN', virus: virus || 'UNKNOWN', spf: ses.receipt.spfVerdict?.status || 'UNKNOWN', dkim: ses.receipt.dkimVerdict?.status || 'UNKNOWN' }
    });
    try { await putMail(item); } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  }
}

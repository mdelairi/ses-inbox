import { ingestNotification } from './ingest.mjs';
import { createMailbox } from './mailbox.mjs';
import { createRepository } from './repository.mjs';
import { createSender } from './send.mjs';
import { createForwarding } from './forwarding.mjs';
import { newMailNotification } from './push.mjs';

// SQS records carry SNS messages: SES receipt notifications or configuration-set events.
export function unwrap(body) {
  const value = JSON.parse(body);
  return value?.Type === 'Notification' && typeof value.Message === 'string' ? JSON.parse(value.Message) : value;
}

// Partial batch responses: only failed records are retried; permanent failures are logged and dropped.
export function createWorker({ pool, objects, ses, bucket, environment, configurationSet, push, log = console.log, warn = console.error }) {
  const repo = createRepository(pool), mailbox = createMailbox({ pool, objects });
  const sender = createSender({ pool, objects, ses, mailbox, bucket, environment });
  const forwarding = createForwarding({ pool, ses, mailbox, configurationSet });
  // Runs once, after a message is first readable in Inbox; a redelivery finds it already published.
  // Failures are logged, never retried: retrying the record cannot re-run them and could not help.
  async function afterInbox(result, parsed) {
    if (push) {
      try { const outcome = await push.notify(newMailNotification({ domain: result.addresses[0].split('@')[1], mailbox: result.addresses[0], threadId: result.threadId, messageId: result.messageId, parsed })); log(JSON.stringify({ kind: 'push-sent', ...outcome })); }
      catch (error) { warn(JSON.stringify({ kind: 'push-failed', error: error.name })); }
    }
    try { const forwarded = await forwarding.forward({ domainId: result.domainId, messageId: result.messageId, aliasIds: result.delivered, parsed }); if (forwarded.length) log(JSON.stringify({ kind: 'mail-forwarded', states: forwarded.map(item => item.state) })); }
    catch (error) { warn(JSON.stringify({ kind: 'forward-failed', error: error.name })); }
  }
  return async event => {
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try {
        const message = unwrap(record.body);
        if (message.notificationType === 'Received') {
          const result = await ingestNotification({ notification: message, repo, objects, bucket, environment });
          log(JSON.stringify({ kind: 'mail-ingested', sesMessageId: message.mail?.messageId, unrouted: result.unrouted, results: result.results.map(item => ({ status: item.status, folder: item.folder })) }));
          for (const item of result.results) if (item.status === 'published' && item.folder === 'inbox' && item.delivered.length) await afterInbox(item, result.parsed);
        } else if (message.eventType) await sender.recordEvent(message);
        else log(JSON.stringify({ kind: 'mail-ignored', messageId: record.messageId }));
      } catch (error) {
        if (error.permanent) { warn(JSON.stringify({ kind: 'mail-rejected', messageId: record.messageId, error: error.message })); continue; }
        warn(JSON.stringify({ kind: 'mail-retry', messageId: record.messageId, error: error.name }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

import { ingestNotification } from './ingest.mjs';
import { createMailbox } from './mailbox.mjs';
import { createRepository } from './repository.mjs';
import { createSender } from './send.mjs';

// SQS records carry SNS messages: SES receipt notifications or configuration-set events.
export function unwrap(body) {
  const value = JSON.parse(body);
  return value?.Type === 'Notification' && typeof value.Message === 'string' ? JSON.parse(value.Message) : value;
}

// Partial batch responses: only failed records are retried; permanent failures are logged and dropped.
export function createWorker({ pool, objects, ses, bucket, environment, log = console.error }) {
  const repo = createRepository(pool), mailbox = createMailbox({ pool, objects });
  const sender = createSender({ pool, objects, ses, mailbox, bucket, environment });
  return async event => {
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try {
        const message = unwrap(record.body);
        if (message.notificationType === 'Received') {
          const result = await ingestNotification({ notification: message, repo, objects, bucket, environment });
          log(JSON.stringify({ kind: 'mail-ingested', sesMessageId: message.mail?.messageId, unrouted: result.unrouted, results: result.results.map(item => ({ status: item.status, folder: item.folder })) }));
        } else if (message.eventType) await sender.recordEvent(message);
        else log(JSON.stringify({ kind: 'mail-ignored', messageId: record.messageId }));
      } catch (error) {
        if (error.permanent) { log(JSON.stringify({ kind: 'mail-rejected', messageId: record.messageId, error: error.message })); continue; }
        log(JSON.stringify({ kind: 'mail-retry', messageId: record.messageId, error: error.name }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

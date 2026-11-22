import { createCaptureImporter } from '../mail/capture-import.mjs';
import { retryable } from '../mail/repository.mjs';

// The copy-saved and delivery notifications for one message usually arrive together, so two
// imports of it can overlap. The second waits here for the first rather than failing into the
// queue's six-minute redelivery, which only delayed the delivery status.
const overlapping = error => ['CaptureImportBusy', 'CaptureOutcomeConflict'].includes(error?.message) || retryable(error);
const WAITS = [500, 1000, 2000, 4000], WAIT_BUDGET = 20000; // the function runs for at most 60 seconds per batch

// Dedicated capture queue. It accepts only its own S3 bucket and explicitly
// allowed producer feedback topics; producer labels never come from arbitrary headers.
export function createCaptureWorker({ pool, objects, captureObjects, bucket, captureBucket, sources, log = console.log, warn = console.error, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  importer = createCaptureImporter({ pool, objects, captureObjects, bucket, sources }) }) {
  return async event => {
    const batchItemFailures = [];
    let waited = 0;
    const patiently = async work => {
      for (let attempt = 0; ; attempt++) {
        try { return await work(); }
        catch (error) {
          if (!overlapping(error) || attempt >= WAITS.length || waited + WAITS[attempt] > WAIT_BUDGET) throw error;
          waited += WAITS[attempt]; await wait(WAITS[attempt]);
        }
      }
    };
    for (const record of event.Records || []) {
      try {
        const envelope = JSON.parse(record.body);
        if (envelope.Event === 's3:TestEvent' && envelope.Bucket === captureBucket) continue;
        if (envelope.Type === 'Notification') {
          const payload = JSON.parse(envelope.Message);
          await patiently(() => importer.recordEvent(payload, envelope.TopicArn));
        } else if (Array.isArray(envelope.Records)) {
          for (const notification of envelope.Records) {
            if (notification.eventSource !== 'aws:s3' || notification.s3?.bucket?.name !== captureBucket) throw new Error('UnexpectedCaptureBucket');
            const key = decodeURIComponent(notification.s3.object.key.replace(/\+/g, ' '));
            const match = /^capture\/([a-z][a-z0-9-]{1,63})\/([a-f0-9-]{36})\/(message|result)\.json$/.exec(key);
            if (!match) throw new Error('UnexpectedCaptureKey');
            const result = await patiently(() => importer.ingest(match[1], match[2]));
            log(JSON.stringify({ event: 'capture-imported', source: match[1], state: result.deleted ? 'deleted' : result.duplicate ? 'duplicate' : 'published' }));
          }
        } else throw new Error('UnexpectedCaptureNotification');
      } catch (error) {
        // Even malformed producer records go to the DLQ after bounded retries,
        // giving the owner a visible sync failure instead of silently claiming coverage.
        warn(JSON.stringify({ event: 'capture-retry', messageId: record.messageId, name: error.name }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

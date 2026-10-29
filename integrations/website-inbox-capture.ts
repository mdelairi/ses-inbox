// Proposed new website module; helpers are copied into ./inbox-capture/.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { captureWriter, createCapturedSender } from './inbox-capture/producer.mjs';
const captured = new WeakMap<SESv2Client, ReturnType<typeof createCapturedSender>>();
export async function sendContactEmail(client: SESv2Client, command: SendEmailCommand, options?: { abortSignal?: AbortSignal }) {
  if (!process.env.INBOX_CAPTURE_BUCKET) return client.send(command, options);
  const source = process.env.INBOX_CAPTURE_SOURCE;
  if (!['website-production', 'website-staging'].includes(source || '')) throw new Error('CaptureSourceConfigurationMismatch');
  let entry = captured.get(client);
  if (!entry) { entry = createCapturedSender({ source, put: captureWriter({ bucket: process.env.INBOX_CAPTURE_BUCKET, region: process.env.AWS_REGION }), send: (wire: SendEmailCommand, requestOptions: { abortSignal?: AbortSignal }) => client.send(wire, requestOptions) }); captured.set(client, entry); }
  return entry({ kind: 'website_contact', input: command.input, options });
}

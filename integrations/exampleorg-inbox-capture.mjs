// Proposed new ExampleOrg module; capture helpers are copied into ./inbox-capture/.
import { captureWriter, createCapturedSender } from './inbox-capture/producer.mjs';
const captured = new WeakMap();
export async function sendProjectEmail({ configuration, client, kind }, command, options) {
  // Sign-up codes use the generic sender without captureKind, and Cognito remains untouched.
  if (!kind || !process.env.INBOX_CAPTURE_BUCKET) return client.send(command, options);
  const expected = `exampleorg-${configuration.environment}`;
  if (process.env.INBOX_CAPTURE_SOURCE !== expected) throw new Error('CaptureSourceConfigurationMismatch');
  let entry = captured.get(client);
  if (!entry) { entry = createCapturedSender({ source: expected, put: captureWriter({ bucket: process.env.INBOX_CAPTURE_BUCKET, region: configuration.region }), send: (wire, requestOptions) => client.send(wire, requestOptions) }); captured.set(client, entry); }
  return entry({ kind, input: command.input, options });
}

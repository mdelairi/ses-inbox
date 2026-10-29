// Read-only toward producer repositories. Emit reviewable diffs in this workspace;
// applying them requires their repository's implementation approval.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url), output = new URL('integrations/producer-patches/', root);
await mkdir(output, { recursive: true });
const scratch = new URL('.audit/producer-review/', root);
await mkdir(scratch, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
let previous;
try { previous = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const edits = [];
function replaceOnce(text, before, after) { if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Review anchor changed: ${before.slice(0, 70)}`); return text.replace(before, after); }
async function propose(project, relative, change) {
  const path = `~/DEV/${project}/${relative}`, current = await readFile(path, 'utf8');
  const patchPath = new URL(`${project}-${relative.replaceAll('/', '_')}.patch`, output);
  const known = previous?.edits.find(entry => entry.project === project && entry.path === relative);
  const applied = !!known && sha(current) === known.proposedSha256;
  // Reconstruct the approved baseline from an already-applied diff. patch writes
  // only to stdout; it never edits the producer checkout. Verify both hashes.
  const original = applied ? execFileSync('patch', ['-R', '-s', '-o', '-', path, patchPath.pathname.replaceAll('%20', ' ')], { encoding: 'utf8' }) : current;
  if (applied && sha(original) !== known.sourceSha256) throw new Error(`Producer baseline mismatch: ${path}`);
  const formatter = `~/DEV/${project}/node_modules/.bin/${project === 'exampleorg' ? 'biome' : 'prettier'}`;
  const changed = execFileSync(formatter, project === 'exampleorg' ? ['format', '--stdin-file-path', relative] : ['--stdin-filepath', relative], { cwd: `~/DEV/${project}`, input: change(original), encoding: 'utf8' });
  if (applied && changed !== current) throw new Error(`Applied producer differs from proposal: ${path}`);
  const before = new URL(`${project}-${relative.replaceAll('/', '_')}.before`, scratch), after = new URL(`${project}-${relative.replaceAll('/', '_')}.after`, scratch);
  await writeFile(before, original); await writeFile(after, changed);
  let patch;
  try { patch = execFileSync('diff', ['-u', '--label', `a/${relative}`, '--label', `b/${relative}`, before.pathname.replaceAll('%20', ' '), after.pathname.replaceAll('%20', ' ')], { encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; patch = error.stdout; }
  await writeFile(patchPath, patch);
  edits.push({ project, path: relative, sourceSha256: sha(original), proposedSha256: sha(changed), applied });
}
const exampleorgImport = "import { sendProjectEmail } from './inbox-capture.mjs';\n";
await propose('exampleorg', 'library/server/invitation-mail.mjs', text => {
  text = exampleorgImport + text;
  text = replaceOnce(text, 'sent = await client.send(\n        new SendEmailCommand({', "sent = await sendProjectEmail({ configuration, client, kind: 'member_invitation' },\n        new SendEmailCommand({");
  text = replaceOnce(text, 'const rejected = [', "const rejected = error.notSent === true || [");
  return text;
});
await propose('exampleorg', 'library/server/learning-mail.mjs', text => {
  text = exampleorgImport + text;
  text = replaceOnce(text, 'const send = async ({ to, email, tags = [] }) => {', 'const send = async ({ to, email, tags = [], captureKind }) => {');
  text = replaceOnce(text, 'const sent = await client.send(\n        new SendEmailCommand({', 'const sent = await sendProjectEmail({ configuration, client, kind: captureKind },\n        new SendEmailCommand({');
  text = replaceOnce(text, '      return { state: \'failed\' };', "      return { state: error.name === 'CaptureBeforeSendError' && !error.notSent ? 'uncertain' : 'failed' };");
  text = replaceOnce(text, '      to: reminder.to,', `      to: reminder.to,
      captureKind: ({ assigned: 'course_assigned', before: 'due_reminder',
        'overdue-1': 'overdue_reminder', 'overdue-2': 'overdue_reminder', 'overdue-3': 'overdue_reminder',
        [DIGEST]: 'weekly_digest', [MARKING]: 'marking_waiting' })[reminder.kind],`);
  text = replaceOnce(text, '      to: delivery.email,', "      to: delivery.email,\n      captureKind: 'course_invitation',");
  return text;
});
await propose('exampleorg', 'infra/delivery-stack.ts', text => {
  const anchor = '    state.access.grantRead(fn);';
  return replaceOnce(text, anchor, `    // Opt-in capture only; never enable email sending or alter existing recipient safeguards.\n    const inboxCaptureBucket = this.node.tryGetContext('inboxCaptureBucket');\n    if (inboxCaptureBucket) {\n      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(inboxCaptureBucket)) throw new Error('Invalid inbox capture bucket');\n      fn.addEnvironment('INBOX_CAPTURE_BUCKET', inboxCaptureBucket);\n      fn.addEnvironment('INBOX_CAPTURE_SOURCE', production ? 'exampleorg-production' : 'exampleorg-staging');\n      fn.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [\`arn:aws:s3:::\${inboxCaptureBucket}/capture/\${production ? 'exampleorg-production' : 'exampleorg-staging'}/*\`] }));\n    }\n${anchor}`);
});
await propose('website', 'functions/contact/handler.ts', text => {
  text = "import { sendContactEmail } from './inbox-capture';\n" + text;
  return replaceOnce(text, 'await ses.send(\n          new SendEmailCommand({', 'await sendContactEmail(ses,\n          new SendEmailCommand({');
});
await propose('website', 'infra/contact-stack.ts', text => {
  const anchor = '    config.grantRead(handler);';
  return replaceOnce(text, anchor, `    // Opt-in Sent capture; the private From/destination routing remains in Secrets Manager.\n    const inboxCaptureBucket = this.node.tryGetContext('inboxCaptureBucket');\n    if (inboxCaptureBucket) {\n      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(inboxCaptureBucket)) throw new Error('Invalid inbox capture bucket');\n      handler.addEnvironment('INBOX_CAPTURE_BUCKET', inboxCaptureBucket);\n      handler.addEnvironment('INBOX_CAPTURE_SOURCE', production ? 'website-production' : 'website-staging');\n      handler.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [\`arn:aws:s3:::\${inboxCaptureBucket}/capture/\${production ? 'website-production' : 'website-staging'}/*\`] }));\n    }\n${anchor}`);
});
await writeFile(new URL('manifest.json', output), JSON.stringify({ producerFilesChanged: edits.some(entry => entry.applied), edits, newFiles: { exampleorg: ['library/server/inbox-capture.mjs', 'library/server/inbox-capture/producer.mjs', 'library/server/inbox-capture/protocol.mjs'], website: ['functions/contact/inbox-capture.ts', 'functions/contact/inbox-capture/producer.mjs', 'functions/contact/inbox-capture/protocol.mjs'] }, newDependency: { exampleorg: '@aws-sdk/client-s3 already present', website: '@aws-sdk/client-s3: match existing AWS SDK version 3.1141.0' } }, null, 2) + '\n');
console.log(`Verified ${edits.length} producer-file diffs (${edits.filter(entry => entry.applied).length} already applied). This command edited neither producer repository.`);

// Bounded live integration check. Temporary owner session stays in memory and is
// explicitly revoked; only the uniquely identified synthetic draft/file is removed.
import { readDeploymentFile } from './lib/deployment-file.mjs';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../stage/package.json', import.meta.url));
const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { fromIni } = require('@aws-sdk/credential-providers');
const c = await readDeploymentFile(new URL('../stage/config.json', import.meta.url));
const release = JSON.parse(await readFile(new URL('../build/stage/release.json', import.meta.url)));
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', c.profile, '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== c.accountId) throw new Error('Wrong staging account');
const code = execFileSync('aws', ['lambda', 'get-function-configuration', '--function-name', `${c.stackPrefix}-app-app`, '--profile', c.profile, '--region', c.region, '--query', 'CodeSha256', '--output', 'text'], { encoding: 'utf8' }).trim();
if (code !== Buffer.from(release.lambdaSha256, 'hex').toString('base64')) throw new Error('The packaged release is not active in staging yet');
const ddb = new DynamoDBClient({ region: c.region, credentials: fromIni({ profile: c.profile }) });
const s3 = new S3Client({ region: c.region, credentials: fromIni({ profile: c.profile }) });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cookie = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url'), pk = `session#${hash(cookie)}`;
const origin = `https://${c.hostname}`, draftId = `smoke-${randomUUID()}`, bytes = Buffer.from('Shared sample storage integration check.');
let fileKey, sessionCreated = false, draftCreated = false, passed = false;
const checks = {};
function ensure(value, label) { if (!value) throw new Error(label); checks[label] = true; }
async function api(path, method = 'GET', value) {
  const body = value === undefined ? undefined : JSON.stringify(value);
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20000), headers: { cookie: `__Host-inbox-session=${cookie}`, ...(body ? { origin, 'content-type': 'application/json', 'x-inbox-csrf': csrf, 'x-amz-content-sha256': hash(body) } : {}) }, body });
  const data = await response.json();
  return { status: response.status, data };
}
async function load() {
  const result = await api('/api/state'); ensure(result.status === 200, 'authenticatedStateRead');
  if (result.data.state) {
    if (result.data.digest) ensure(hash(JSON.stringify(result.data.state)) === result.data.digest, 'stateChecksum');
    return { revision: result.data.revision, state: result.data.state };
  }
  const response = await fetch(result.data.url), bytes = Buffer.from(await response.arrayBuffer());
  ensure(response.ok && hash(bytes) === result.data.digest, 'stateChecksum');
  return { revision: result.data.revision, state: JSON.parse(bytes) };
}
async function save(snapshot) { return api('/api/state', 'PUT', { ...snapshot, writeId: randomUUID() }); }
async function removeDraft() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await load();
    current.state.drafts = current.state.drafts.filter(draft => draft.id !== draftId);
    const result = await save(current);
    if (result.status === 200) { draftCreated = false; return; }
    if (result.status !== 409) throw new Error(`Synthetic draft cleanup failed (${result.status})`);
  }
  throw new Error('Synthetic draft cleanup conflicted repeatedly');
}
try {
  ensure((await fetch(origin + '/api/state')).status === 401, 'signedOutApiDenied');
  const { Item } = await ddb.send(new GetItemCommand({ TableName: c.authTable, Key: { pk: { S: 'owner' } }, ConsistentRead: true }));
  ensure(Item?.sub?.S && Item.email?.S === c.ownerEmail && !Item.disabled?.BOOL, 'pinnedOwnerVerified');
  await ddb.send(new PutItemCommand({ TableName: c.authTable, Item: { pk: { S: pk }, sub: { S: Item.sub.S }, csrf: { S: csrf }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 600) } } })); sessionCreated = true;
  const initial = await load();
  const ticket = await api('/api/files/upload', 'POST', { sha256: hash(bytes), size: bytes.length });
  ensure(ticket.status === 200, 'uploadTicket'); fileKey = ticket.data.objectKey;
  ensure((await fetch(ticket.data.url, { method: 'PUT', headers: ticket.data.headers, body: bytes })).ok, 'signedS3Upload');
  const domain = initial.state.domains.find(domain => domain.aliases.some(alias => alias.enabled));
  const alias = domain.aliases.find(alias => alias.enabled);
  initial.state.drafts.push({ id: draftId, domain: domain.id, mailbox: alias.address, aliasId: alias.id, to: 'fixture@example.invalid', cc: '', bcc: '', subject: 'Staging storage verification (sample)', text: 'Synthetic draft, not an outgoing email.', html: '<p>Synthetic draft, not an outgoing email.</p>', updatedAt: new Date().toISOString(), attachments: [{ id: randomUUID(), name: 'storage-check.txt', type: 'text/plain', size: bytes.length, objectKey: fileKey, sha256: hash(bytes) }] });
  draftCreated = true; const written = await save(initial); ensure(written.status === 200, 'draftPublished');
  const fresh = await load(); ensure(fresh.state.drafts.some(draft => draft.id === draftId), 'independentDraftRead');
  const download = await api('/api/files/download', 'POST', { objectKey: fileKey });
  ensure(download.status === 200 && Buffer.from(await (await fetch(download.data.url)).arrayBuffer()).equals(bytes), 'attachmentRoundtrip');
  ensure((await save(initial)).status === 409, 'staleWriteRejected');
  await removeDraft();
  ensure((await api('/api/files/download', 'POST', { objectKey: fileKey })).status === 404, 'removedFileCannotBeSigned');
  passed = true;
} finally {
  let cleanupError;
  if (draftCreated) try { await removeDraft(); } catch (error) { cleanupError = error; }
  const cleanup = await Promise.allSettled([
    ...(!draftCreated && fileKey ? [s3.send(new DeleteObjectCommand({ Bucket: c.mailBucket, Key: fileKey }))] : []),
    ...(sessionCreated ? [ddb.send(new DeleteItemCommand({ TableName: c.authTable, Key: { pk: { S: pk } } }))] : []),
  ]);
  if (cleanupError || cleanup.some(result => result.status === 'rejected')) throw new Error('Live-check cleanup needs attention; temporary session has a ten-minute maximum lifetime.');
}
if (passed) {
  await writeFile(new URL('../stage/shared-checks.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), url: origin, lambdaSha256: release.lambdaSha256, checks, syntheticDraftRemoved: true, temporarySessionRevoked: true }, null, 2) + '\n');
  console.log('Live shared-storage checks passed; synthetic draft and test session cleaned up.');
}

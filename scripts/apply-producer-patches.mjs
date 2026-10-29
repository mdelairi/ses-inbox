// Apply only the producer files in the reviewed manifest, with exact source
// hashes. Does not deploy, change sending settings or invoke any AWS API.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('integrations/producer-patches/manifest.json', root)));
const sha = value => createHash('sha256').update(value).digest('hex');
const writes = [];
async function plan(path, contents, expected) {
  let current;
  try { current = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current && sha(current) === sha(contents)) return;
  if (expected ? !current || sha(current) !== expected : current) throw new Error(`Refusing changed producer file: ${path}`);
  writes.push({ path, contents, expected });
}
for (const entry of manifest.edits) {
  if (!['exampleorg', 'website'].includes(entry.project) || entry.path.includes('..') || entry.path.startsWith('/')) throw new Error('InvalidProducerPath');
  const contents = await readFile(new URL(`.audit/producer-review/${entry.project}-${entry.path.replaceAll('/', '_')}.after`, root));
  if (sha(contents) !== entry.proposedSha256) throw new Error(`Proposal hash mismatch: ${entry.path}`);
  await plan(`~/DEV/${entry.project}/${entry.path}`, contents, entry.sourceSha256);
}
for (const [project, base, adapter] of [['exampleorg', 'library/server', 'exampleorg-inbox-capture.mjs'], ['website', 'functions/contact', 'website-inbox-capture.ts']]) {
  const files = [[`${base}/inbox-capture.${project === 'exampleorg' ? 'mjs' : 'ts'}`, `integrations/${adapter}`],
    [`${base}/inbox-capture/producer.mjs`, 'capture/producer.mjs'], [`${base}/inbox-capture/protocol.mjs`, 'capture/protocol.mjs']];
  for (const [relative, source] of files) {
    const formatter = `~/DEV/${project}/node_modules/.bin/${project === 'exampleorg' ? 'biome' : 'prettier'}`;
    const contents = execFileSync(formatter, project === 'exampleorg' ? ['format', '--stdin-file-path', relative] : ['--stdin-filepath', relative], { cwd: `~/DEV/${project}`, input: await readFile(new URL(source, root)) });
    await plan(`~/DEV/${project}/${relative}`, contents);
  }
}
const websitePackagePath = '~/DEV/website/package.json';
const websitePackageBytes = await readFile(websitePackagePath), websitePackage = JSON.parse(websitePackageBytes);
if (websitePackage.dependencies['@aws-sdk/client-sesv2'] !== '3.1141.0') throw new Error('WebsiteSDKVersionChanged');
if (websitePackage.dependencies['@aws-sdk/client-s3'] && websitePackage.dependencies['@aws-sdk/client-s3'] !== '3.1141.0') throw new Error('WebsiteS3VersionChanged');
websitePackage.dependencies = Object.fromEntries(Object.entries({ ...websitePackage.dependencies, '@aws-sdk/client-s3': '3.1141.0' }).sort(([a], [b]) => a.localeCompare(b)));
await plan(websitePackagePath, JSON.stringify(websitePackage, null, 2) + '\n', sha(websitePackageBytes));
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ apply: false, files: writes.map(({ path }) => path), cloudChanges: false }, null, 2));
} else {
  for (const { path, contents, expected } of writes) {
    // Recheck immediately before each write to preserve concurrent edits.
    let current;
    try { current = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (expected ? !current || sha(current) !== expected : current) throw new Error(`Producer changed during apply: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, expected ? undefined : { flag: 'wx' });
  }
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/prepare-producer-patches.mjs', root))], { cwd: fileURLToPath(root), stdio: 'inherit' });
  console.log(`Applied ${writes.length} reviewed local files. Regenerate the website lockfile next. Nothing was deployed or sent.`);
}

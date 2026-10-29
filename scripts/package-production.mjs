// Builds the production release ZIP (gateway + mail API in index.mjs, worker in worker.mjs)
// and the CloudFormation templates. Local only; nothing is uploaded or deployed.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { applicationTemplate, artifactTemplate, certificateTemplate, receivingTemplate, recoveryTemplate, storageTemplate } from '../infra/production.mjs';
import { captureTemplate, producerFeedbackTemplate } from '../infra/capture.mjs';
const root = new URL('../', import.meta.url), output = new URL('build/production/', root), lambda = new URL('lambda/', output);
const sha = value => createHash('sha256').update(value).digest('hex');
execFileSync(process.execPath, [fileURLToPath(new URL('scripts/prepare-live.mjs', root))], { stdio: 'inherit' });
await rm(output, { recursive: true, force: true });
await mkdir(new URL('templates/', output), { recursive: true });
await mkdir(lambda, { recursive: true });
const banner = { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' };
for (const [entry, file] of [['stage/entry.mjs', 'index.mjs'], ['mail/worker-entry.mjs', 'worker.mjs'], ['mail/maintenance-entry.mjs', 'maintenance.mjs'], ['capture/entry.mjs', 'capture.mjs']]) {
  await build({ entryPoints: [fileURLToPath(new URL(entry, root))], outfile: fileURLToPath(new URL(file, lambda)), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner, logLevel: 'warning' });
}
await cp(new URL('build/live/assets/', root), new URL('assets/', lambda), { recursive: true });
await cp(new URL('build/live/assets-manifest.json', root), new URL('assets-manifest.json', lambda));
execFileSync('zip', ['-q', '-X', '-r', '../lambda.zip', 'index.mjs', 'worker.mjs', 'maintenance.mjs', 'capture.mjs', 'assets-manifest.json', 'assets'], { cwd: fileURLToPath(lambda) });
const zip = await readFile(new URL('lambda.zip', output)), lambdaSha256 = sha(zip);
const templates = { artifacts: artifactTemplate(), certificate: certificateTemplate(), storage: storageTemplate(), application: applicationTemplate(), receiving: receivingTemplate(), recovery: recoveryTemplate(), capture: captureTemplate(), producerFeedback: producerFeedbackTemplate() };
for (const [name, template] of Object.entries(templates)) {
  const value = JSON.stringify(template, null, 2) + '\n';
  if (Buffer.byteLength(value) > 51_200) throw new Error(`${name} template exceeds the inline size limit`);
  await writeFile(new URL(`templates/${name}.json`, output), value);
}
const assets = JSON.parse(await readFile(new URL('build/live/assets-manifest.json', root)));
await writeFile(new URL('release.json', output), JSON.stringify({ environment: 'production', lambdaSha256, artifactKey: `releases/${lambdaSha256}/lambda.zip`, assets, cloudResourcesCreated: false }, null, 2) + '\n');
console.log(`Packaged build/production/lambda.zip (${zip.length} bytes), key releases/${lambdaSha256}/lambda.zip. Nothing was uploaded or deployed.`);

import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { artifactTemplate, certificateTemplate, applicationTemplate } from '../infra/stage.mjs';
const root = new URL('../', import.meta.url), output = new URL('build/stage/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
// This path contains generated artifacts only, never browser state or credentials.
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await mkdir(new URL('source/', output), { recursive: true });
await mkdir(new URL('templates/', output), { recursive: true });
await cp(new URL('web/', root), new URL('assets/', output), { recursive: true });
const app = new URL('assets/app.mjs', output);
let content = await readFile(app, 'utf8');
content = content.replaceAll('Local prototype', 'Staging · sample mail').replace('Google sign-in will be connected later', 'Owner-only Google sign-in').replace('<span>Aliases & settings</span></button></div>', '<span>Aliases & settings</span></button><button class="folder-button" data-action="stage-signout">${icon(\'close\')}<span>Sign out</span></button></div>');
await writeFile(app, content);
const localDb = new URL('assets/local-db.mjs', output);
await writeFile(localDb, (await readFile(localDb, 'utf8')).replace('project-inbox-local-v1', 'project-inbox-staging-sample-v1'));
const html = new URL('assets/index.html', output);
await writeFile(html, (await readFile(html, 'utf8')).replace('<body>', '<body data-environment="staging">').replace('<script type="module" src="/app.mjs"></script>', '<script type="module" src="/stage-client.mjs"></script>\n  <script type="module" src="/app.mjs"></script>'));
await cp(new URL('stage/client.mjs', root), new URL('assets/stage-client.mjs', output));
for (const name of ['auth.mjs', 'entry.mjs', 'google.mjs', 'package.json']) await cp(new URL(`stage/${name}`, root), new URL(`source/${name}`, output));
try { await cp(new URL('stage/package-lock.json', root), new URL('source/package-lock.json', output)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const templates = { artifacts: artifactTemplate(), certificate: certificateTemplate(), application: applicationTemplate() };
for (const [name, template] of Object.entries(templates)) {
  const value = JSON.stringify(template, null, 2) + '\n';
  if (Buffer.byteLength(value) > 51_200) throw new Error('Template exceeds inline size limit');
  await writeFile(new URL(`templates/${name}.json`, output), value);
}
async function list(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...await list(new URL(`${entry.name}/`, directory), prefix + entry.name + '/'));
    else files.push(prefix + entry.name);
  }
  return files;
}
const assets = {};
for (const file of await list(new URL('assets/', output))) assets[file] = sha(await readFile(new URL(`assets/${file}`, output)));
await writeFile(new URL('assets-manifest.json', output), JSON.stringify(assets, null, 2) + '\n');
const sources = {};
for (const file of await list(new URL('source/', output))) sources[file] = sha(await readFile(new URL(`source/${file}`, output)));
const releaseId = sha(JSON.stringify({ assets, sources, templates }));
const config = JSON.parse(await readFile(new URL('stage/config.json', root)));
const manifest = { releaseId, scope: config.scope, environment: 'staging', proposedOrigin: `https://${config.hostname}`, assets, sources, cloudResourcesCreated: false, authenticationBundleBuilt: false };
await writeFile(new URL('release.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Staging source prepared: build/stage/\nRelease: ${releaseId}\nNo AWS resources created. Authentication dependency install and Lambda packaging still required.`);

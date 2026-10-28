// Builds the real-mail web assets: the prototype UI with web/live-mail.mjs as its storage
// adapter and the gateway's session client. Local only; nothing is uploaded or deployed.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url), output = new URL('build/live/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await cp(new URL('web/', root), new URL('assets/', output), { recursive: true });
await rm(new URL('assets/fixtures.mjs', output)); // Live mail never ships sample data...
await writeFile(new URL('assets/fixtures.mjs', output), "export function seedState() { throw new Error('Sample data is not available with live mail.'); }\n"); // ...but app.mjs still imports it.
await cp(new URL('web/live-mail.mjs', root), new URL('assets/local-db.mjs', output));
await rm(new URL('assets/live-mail.mjs', output));
const app = new URL('assets/app.mjs', output);
const content = (await readFile(app, 'utf8')).replace('<span>Aliases & settings</span></button></div>', '<span>Aliases & settings</span></button><button class="folder-button" data-action="stage-signout">${icon(\'close\')}<span>Sign out</span></button></div>');
if (!content.includes('stage-signout')) throw new Error('Sign-out control could not be added');
await writeFile(app, content);
const html = new URL('assets/index.html', output);
await writeFile(html, (await readFile(html, 'utf8')).replace('<body>', '<body data-environment="production">').replace('<script type="module" src="/app.mjs"></script>', '<script type="module" src="/stage-client.mjs"></script>\n  <script type="module" src="/app.mjs"></script>'));
await cp(new URL('stage/client.mjs', root), new URL('assets/stage-client.mjs', output));
const assets = {};
for (const name of (await readdir(new URL('assets/', output))).sort()) assets[name] = sha(await readFile(new URL(`assets/${name}`, output))); // web/ is flat
await writeFile(new URL('assets-manifest.json', output), JSON.stringify(assets, null, 2) + '\n');
console.log(`Live mail assets prepared: build/live/ (${Object.keys(assets).length} files). Nothing was uploaded or deployed.`);

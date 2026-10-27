import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url), output = new URL('build/stage/', root);
await import('./prepare-stage.mjs');
const requireStage = createRequire(new URL('stage/package.json', root));
try { await access(new URL('stage/package-lock.json', root)); await access(new URL('stage/node_modules/esbuild/package.json', root)); }
catch { console.error('Not packaged: install stage dependencies and retain stage/package-lock.json first. Run npm install --prefix stage --ignore-scripts.'); process.exit(1); }
const { build } = await import(requireStage.resolve('esbuild'));
await mkdir(new URL('lambda/', output), { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('stage/entry.mjs', root))], outfile: fileURLToPath(new URL('lambda/index.mjs', output)), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
await cp(new URL('assets/', output), new URL('lambda/assets/', output), { recursive: true });
await cp(new URL('assets-manifest.json', output), new URL('lambda/assets-manifest.json', output));
execFileSync('zip', ['-q', '-r', '../lambda.zip', 'index.mjs', 'assets-manifest.json', 'assets'], { cwd: fileURLToPath(new URL('lambda/', output)) });
const bytes = await readFile(new URL('lambda.zip', output));
const manifest = JSON.parse(await readFile(new URL('release.json', output)));
manifest.authenticationBundleBuilt = true;
manifest.lambdaSha256 = createHash('sha256').update(bytes).digest('hex');
manifest.artifactKey = `releases/${manifest.lambdaSha256}/lambda.zip`;
await writeFile(new URL('release.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Packaged build/stage/lambda.zip (${bytes.length} bytes). No upload or deployment performed.`);

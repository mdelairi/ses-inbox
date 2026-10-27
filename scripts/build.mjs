import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
await mkdir('build', { recursive: true });
for (const entry of ['api', 'inbound']) {
  await build({ entryPoints: [`server/${entry}.mjs`], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: `build/${entry}/index.cjs` });
}
await rm('dist', { recursive: true, force: true });
await cp('web', 'dist', { recursive: true });
console.log('Built Lambda functions and web app.');

// Deployment records (stage/config.json, production/deployment.json, ...) describe one
// person's AWS resources and are gitignored. The tracked *.example.json files show the shape.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function readDeploymentFile(url) {
  try { return JSON.parse(await readFile(url)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const path = fileURLToPath(url), example = path.replace(/\.json$/, '.example.json');
    throw new Error(`${path} is missing. Copy ${example} to that path and fill in your own deployment values.`);
  }
}

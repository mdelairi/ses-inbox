import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accounts } from '../infra/accounts.mjs';
import { readDeploymentFile } from './lib/deployment-file.mjs';
const root = new URL('../', import.meta.url);
const config = await readDeploymentFile(new URL('stage/config.json', root));
const checks = [], add = (label, ok, detail = '') => checks.push({ label, ok, ...(detail ? { detail } : {}) });
add('Staging account and region are isolated', config.environment === 'staging' && config.accountId === accounts.staging && config.region === accounts.region);
add('Owner account is explicit', config.ownerEmail === accounts.ownerEmail);
add('Dedicated Example staging hostname', /^[a-z0-9-]+\.example\.com$/.test(config.hostname));
for (const field of ['googleSecretArn', 'certificateArn', 'artifactBucket', 'mailBucket', 'mailDatabaseHost', 'mailDatabaseArn']) add(`${field} is configured`, Boolean(config[field]));
try { await access(new URL('stage/package-lock.json', root)); add('Staging dependency lockfile exists', true); }
catch { add('Staging dependency lockfile exists', false, 'Dependency installation is pending'); }
try {
  const release = JSON.parse(await readFile(new URL('build/stage/release.json', root)));
  add('Authentication Lambda is packaged', release.authenticationBundleBuilt === true);
  if (release.authenticationBundleBuilt) {
    const bytes = await readFile(new URL('build/stage/lambda.zip', root));
    add('Lambda ZIP matches release checksum', createHash('sha256').update(bytes).digest('hex') === release.lambdaSha256);
  }
} catch { add('Prepared release exists', false, 'Run npm run stage:prepare'); }
if (process.argv.includes('--aws')) {
  try {
    const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', config.profile, '--output', 'json'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
    add('Live AWS identity matches staging', identity.Account === config.accountId);
    if (identity.Account === config.accountId) {
      for (const template of ['artifacts', 'certificate', 'storage', 'application']) {
        try { execFileSync('aws', ['cloudformation', 'validate-template', '--profile', config.profile, '--region', config.region, '--template-body', `file://${fileURLToPath(new URL(`build/stage/templates/${template}.json`, root))}`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); add(`AWS accepts ${template} template structure`, true); }
        catch { add(`AWS accepts ${template} template structure`, false, 'Run the validation command directly for diagnostics'); }
      }
    }
  } catch (error) {
    const diagnostic = error.stderr?.toString() || '';
    const detail = /expired|sso|credentials|refresh failed/i.test(diagnostic) ? 'AWS SSO sign-in is required' : /endpoint|connect|resolve|SSL/i.test(diagnostic) ? 'AWS network access failed; retry outside the restricted network sandbox' : 'AWS identity check failed; run aws sts get-caller-identity for diagnostics';
    add('Live AWS identity matches staging', false, detail);
  }
}
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'PENDING'} ${check.label}${check.detail ? `: ${check.detail}` : ''}`);
console.log('This command never creates, uploads, or deploys resources. AWS template validation is not a full resource-schema or change-set validation.');
if (checks.some(check => !check.ok)) process.exitCode = 1;

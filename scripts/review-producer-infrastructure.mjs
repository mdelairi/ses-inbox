// Offline baseline/default/enabled CDK comparisons. Nothing contacts AWS.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = new URL('../', import.meta.url), output = new URL('.audit/producer-infrastructure/', root);
await mkdir(output, { recursive: true });
const results = [];
for (const project of ['exampleorg', 'website']) {
  const projectRoot = `~/DEV/${project}`, require = createRequire(`${projectRoot}/package.json`);
  const source = project === 'exampleorg' ? 'infra/delivery-stack.ts' : 'infra/contact-stack.ts';
  const baseline = execFileSync('patch', ['-R', '-s', '-o', '-', `${projectRoot}/${source}`, fileURLToPath(new URL(`integrations/producer-patches/${project}-${source.replaceAll('/', '_')}.patch`, root))], { encoding: 'utf8' });
  for (const environment of ['staging', 'production']) {
    const templates = {};
    for (const mode of ['baseline', 'default', 'enabled']) {
      const name = `${project}-${environment}-${mode}`;
      const context = mode === 'enabled' ? { inboxCaptureBucket: 'review-only-inbox-capture' } : {};
      const shared = `import { App } from 'aws-cdk-lib'; import { Template } from 'aws-cdk-lib/assertions';
        const app = new App({ outdir: ${JSON.stringify(fileURLToPath(new URL(`${name}/`, output)))}, context: ${JSON.stringify(context)} });`;
      const code = project === 'exampleorg' ? `${shared}
        import { DeliveryStack } from '${projectRoot}/infra/delivery-stack.ts';
        import { StateStack } from '${projectRoot}/infra/state-stack.ts';
        import { ${environment === 'staging' ? 'stage' : 'production'} as configuration } from '${projectRoot}/config/${environment === 'staging' ? 'stage' : 'production'}.mjs';
        const env = { account: configuration.account, region: configuration.region };
        const state = new StateStack(app, 'State', { env, origin: configuration.frontendOrigin, configuration });
        const stack = new DeliveryStack(app, 'Delivery', { env, state, origin: configuration.frontendOrigin, configuration });
        export default Template.fromStack(stack).toJSON();` : `${shared}
        import { ContactStack } from '${projectRoot}/infra/contact-stack.ts';
        const stack = new ContactStack(app, 'Contact', { env: { account: '${environment === 'staging' ? '222222222222' : '111111111111'}', region: 'us-east-1' },
          ${environment === 'production' ? "siteOrigin: 'https://example.com', stageName: 'prod', configurationSecretName: 'taylor-website/production/contact', reservedConcurrentExecutions: 5," : ''} });
        export default Template.fromStack(stack).toJSON();`;
      const outfile = new URL(`${name}.mjs`, output);
      await build({ stdin: { contents: code, resolveDir: projectRoot, loader: 'ts' }, outfile: fileURLToPath(outfile), bundle: true, platform: 'node', target: 'node22', format: 'esm',
        plugins: [{ name: 'producer-packages-and-baseline', setup(build) {
          build.onResolve({ filter: /^[^./]/ }, args => ({ path: require.resolve(args.path), external: true }));
          if (mode === 'baseline') build.onLoad({ filter: project === 'exampleorg' ? /\/infra\/delivery-stack\.ts$/ : /\/infra\/contact-stack\.ts$/ }, args => ({ contents: baseline, loader: 'ts', resolveDir: dirname(args.path) }));
        } }] });
      const originalCwd = process.cwd();
      process.chdir(projectRoot);
      try { templates[mode] = (await import(outfile)).default; }
      finally { process.chdir(originalCwd); }
      await writeFile(new URL(`${name}.json`, output), JSON.stringify(templates[mode], null, 2) + '\n');
    }
    assert.deepEqual(templates.default, templates.baseline, `${project}/${environment}: default infrastructure changed`);
    const normalized = structuredClone(templates.enabled), sourcePrefix = `${project}-${environment}`;
    const functions = Object.values(normalized.Resources).filter(resource => resource.Type === 'AWS::Lambda::Function' && resource.Properties.Environment?.Variables?.INBOX_CAPTURE_BUCKET);
    assert.equal(functions.length, 1);
    const variables = functions[0].Properties.Environment.Variables;
    assert.equal(variables.INBOX_CAPTURE_BUCKET, 'review-only-inbox-capture');
    assert.equal(variables.INBOX_CAPTURE_SOURCE, sourcePrefix);
    delete variables.INBOX_CAPTURE_BUCKET; delete variables.INBOX_CAPTURE_SOURCE;
    let grants = 0;
    for (const resource of Object.values(normalized.Resources).filter(resource => resource.Type === 'AWS::IAM::Policy')) {
      resource.Properties.PolicyDocument.Statement = resource.Properties.PolicyDocument.Statement.filter(statement => {
        if (JSON.stringify(statement.Resource).includes('/capture/')) {
          assert.equal(statement.Action, 's3:PutObject');
          assert.equal(statement.Resource, `arn:aws:s3:::review-only-inbox-capture/capture/${sourcePrefix}/*`);
          grants++; return false;
        }
        return true;
      });
    }
    assert.equal(grants, 1);
    assert.deepEqual(normalized, templates.default, `${project}/${environment}: unrelated infrastructure changed`);
    results.push({ project, environment, defaultMatchesBaseline: true, enabledChanges: ['INBOX_CAPTURE_BUCKET', 'INBOX_CAPTURE_SOURCE', `s3:PutObject capture/${sourcePrefix}/*`], resourceReplacements: 0, cloudChanges: false });
  }
}
await writeFile(new URL('review.json', output), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));

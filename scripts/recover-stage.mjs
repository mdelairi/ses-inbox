// Explicit operator recovery for the shared sample workspace. Uses the scoped
// inbox_maintenance database role, never admin. Dry run unless --apply is given.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createMaintenanceStore } from '../stage/maintenance-store.mjs';
import { listRecoverable, recoverMissing } from '../stage/maintenance.mjs';

const usage = `Usage:
  node scripts/recover-stage.mjs                                   list recoverable versions
  node scripts/recover-stage.mjs --object-key K --version-id V     dry run: report what would be restored
  node scripts/recover-stage.mjs --object-key K --version-id V --apply --expected-revision N [--repair-unreadable]`;
const { values: args } = parseArgs({ options: { 'object-key': { type: 'string' }, 'version-id': { type: 'string' }, 'expected-revision': { type: 'string' }, apply: { type: 'boolean' }, 'repair-unreadable': { type: 'boolean' }, owner: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log(usage); process.exit(0); }
if (!args['object-key'] !== !args['version-id']) throw new Error(`Give both --object-key and --version-id.\n${usage}`);
if ((args.apply || args['repair-unreadable']) && !args['object-key']) throw new Error(`--apply needs a source version.\n${usage}`);
if (args.apply && !/^\d+$/.test(args['expected-revision'] || '')) throw new Error('--apply needs --expected-revision from a dry run, so a newer save cannot be overtaken.');

const config = JSON.parse(await readFile(new URL('../stage/config.json', import.meta.url)));
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', config.profile, '--output', 'json'], { encoding: 'utf8' }));
if (identity.Account !== config.accountId) throw new Error('Wrong staging account');
const store = createMaintenanceStore({ bucket: config.mailBucket, host: config.mailDatabaseHost, region: config.region, profile: config.profile });
try {
  const owners = await store.heads.owners();
  const owner = args.owner || (owners.length === 1 ? owners[0] : undefined);
  if (!owner || !owners.includes(owner)) throw new Error(`Choose one workspace owner with --owner: ${owners.join(', ') || 'none found'}`);
  const head = await store.heads.get(owner);
  if (!args['object-key']) {
    const sources = await listRecoverable({ ...store, owner });
    console.log(`Current revision ${head.revision}. ${sources.length} recoverable version(s), newest first:`);
    for (const item of sources) console.log(`  retired ${item.retiredAt}  purge after ${item.purgeAfter}\n    --object-key ${item.objectKey} --version-id ${item.versionId}`);
  } else {
    const report = await recoverMissing({ ...store, owner, objectKey: args['object-key'], versionId: args['version-id'], expectedRevision: args.apply ? Number(args['expected-revision']) : head.revision, apply: Boolean(args.apply), repairUnreadable: Boolean(args['repair-unreadable']) });
    console.log(JSON.stringify(report, null, 2));
    if (!report.applied) console.log(`Dry run only. To restore, repeat with --apply --expected-revision ${report.revision}${report.unreadableCurrent ? ' --repair-unreadable (current snapshot is unreadable; review first)' : ''}.`);
  }
} catch (error) {
  if (error.message === 'MaintenanceLockBusy') throw new Error('The hourly cleanup holds the workspace lock. Retry in a few minutes.');
  throw error;
} finally { await store.close(); }

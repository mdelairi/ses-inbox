import { productionContext } from './production-recovery-context.mjs';
import { preserveRaw } from '../mail/preserve-raw.mjs';
const context = await productionContext();
try { console.log(JSON.stringify(await preserveRaw({ pool: context.pool, objects: context.objects, bucket: context.storage.MailBucket, apply: process.argv.includes('--apply') }))); }
catch (error) { console.error(error.message, error.result || ''); process.exitCode = 1; }
finally { await context.pool.end(); }

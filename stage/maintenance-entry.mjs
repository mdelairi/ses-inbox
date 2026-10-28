import { createMaintenanceStore } from './maintenance-store.mjs';
import { reconcileOwner } from './maintenance.mjs';
const store = createMaintenanceStore({ bucket: process.env.MAIL_BUCKET, host: process.env.MAIL_DATABASE_HOST, region: process.env.AWS_REGION });
const metric = values => console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'ProjectInbox/Retention', Dimensions: [[]], Metrics: Object.keys(values).map(Name => ({ Name, Unit: 'Count' })) }] }, ...values }));
export async function handler() {
  try {
    const total = { retired: 0, deletedVersions: 0, expiredVersionsRemaining: 0, deadlineBreaches: 0 };
    for (const owner of await store.heads.owners()) {
      const result = await reconcileOwner({ ...store, owner });
      for (const key of Object.keys(total)) total[key] += result[key];
    }
    metric({ DeadlineBreaches: total.deadlineBreaches, ExpiredVersionsRemaining: total.expiredVersionsRemaining });
    if (total.expiredVersionsRemaining) throw new Error('ExpiredVersionsRemain');
    metric({ CleanupSuccess: 1 });
    return total;
  } catch (error) {
    metric({ CleanupFailure: 1 }); console.error('retention-failure', { name: error.name }); throw new Error('RetentionCleanupFailed');
  }
}

// Deadline cleanup is independent of preservation. Attempt every stage, then fail
// the invocation if any stage failed so Lambda's error alarm remains authoritative.
export async function runMaintenanceStages(stages, { checkTime = () => {}, onFailure = () => {} } = {}) {
  const results = {}, failures = [];
  for (const [stage, work] of Object.entries(stages)) {
    try { checkTime(); results[stage] = await work(); }
    catch (error) { failures.push(stage); onFailure(stage, error); }
  }
  if (failures.length) throw Object.assign(new Error('MaintenanceStageFailed'), { stages: failures });
  return results;
}

const JOB_RESULTS = new Set([
  'migration/history/create', 'migration/history/read', 'migration/history/run',
  'migration/history/cancel', 'migration/history/resume', 'migration/history/reinterpret/create',
]);
const legacyJob = value => {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'workerState')) return value;
  const { workerState: _privateChoice, ...legacy } = value;
  return legacy;
};

/** A shared Native connection may opt in even when one attached client uses the old schema. */
export function projectMigrationHistoryWorkerState(message, method, optedIn) {
  if (optedIn || message.error || !message.result) return message;
  if (JOB_RESULTS.has(method)) return { ...message, result: legacyJob(message.result) };
  if (method === 'migration/history/jobs' && Array.isArray(message.result.jobs)) {
    return { ...message, result: { ...message.result, jobs: message.result.jobs.map(legacyJob) } };
  }
  return message;
}

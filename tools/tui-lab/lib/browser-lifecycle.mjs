export async function settleLifecycleStep(
  name,
  action,
  timeoutMs = 5000,
  runtime = {},
) {
  const setTimer = runtime.setTimeout || setTimeout;
  const clearTimer = runtime.clearTimeout || clearTimeout;
  let timer;
  const outcome = await Promise.race([
    Promise.resolve()
      .then(action)
      .then(
        (value) => ({ name, status: "completed", value }),
        (error) => ({ name, status: "rejected", error }),
      ),
    new Promise((resolve) => {
      timer = setTimer(() => resolve({ name, status: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimer(timer);
  return outcome;
}

export function validateBrowserCleanup(report) {
  const failed = report.steps.filter((step) => step.status !== "completed");
  if (failed.length > 0 || !report.ptyExitObserved) {
    const details = [
      ...failed.map((step) => `${step.name}:${step.status}`),
      ...(!report.ptyExitObserved ? ["pty-exit:not-observed"] : []),
    ];
    const error = new Error(
      `browser scenario cleanup incomplete: ${details.join(", ")}`,
    );
    error.cleanup = report;
    throw error;
  }
  return report;
}

export async function runBrowserScenarioLifecycle({
  execute,
  captureBeforeCleanup = async () => undefined,
  onFailure,
  cleanup,
  onSuccess = async (value) => value,
  validateCleanup = validateBrowserCleanup,
}) {
  let cleanupPromise;
  const cleanupOnce = () => {
    cleanupPromise ||= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };

  let result;
  try {
    result = await execute();
  } catch (error) {
    const pageEvidence = await captureBeforeCleanup(error);
    try {
      error.cleanup = await cleanupOnce();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    await onFailure(error, pageEvidence);
    throw error;
  }

  // The page is usually closed after cleanup itself fails, so retain failure-artifact evidence in memory first.
  const pageEvidence = await captureBeforeCleanup();
  try {
    const cleanupReport = await cleanupOnce();
    validateCleanup(cleanupReport);
    return await onSuccess(result, cleanupReport);
  } catch (error) {
    await onFailure(error, pageEvidence);
    throw error;
  }
}

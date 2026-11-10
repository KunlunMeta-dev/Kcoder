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

// Retain every original session object across process replacement until its exit is confirmed.
export async function cleanupOwnedBrowserSessions({ browser, sessions, timeoutMs = 5000, exitTimeoutMs = 1000 }) {
  const steps = [];
  const exits = [];
  const record = outcome => ({
    ...outcome,
    ...(outcome.error ? { error: { name: outcome.error.name || 'Error', message: outcome.error.message || String(outcome.error) } } : {}),
  });
  if (browser) steps.push(record(await settleLifecycleStep('browser', () => browser.close(), timeoutMs)));
  for (const [index, session] of sessions.entries()) {
    steps.push(record(await settleLifecycleStep(`session-${index + 1}`, () => session.stop(), timeoutMs)));
    const exit = record(await settleLifecycleStep(`pty-exit-${index + 1}`, () => session.exitPromise, exitTimeoutMs));
    steps.push(exit);
    exits.push(exit);
  }
  return {
    steps,
    ptyExitObserved: exits.every(exit => exit.status === 'completed'),
    ptyExits: exits.map(exit => exit.value ?? null),
    // The private profile contains resume evidence; never delete it after unknown cleanup.
    profileRetained: true,
  };
}

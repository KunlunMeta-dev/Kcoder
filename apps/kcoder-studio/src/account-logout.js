/**
 * Logout cleanup policy for a KCoder account binding (A1/R124).
 *
 * Logging out of a target must remove that device profile's remembered
 * credential so a later automatic restore cannot bring the account back. The
 * identity-scoped removal is the precise one, but when it cannot be applied
 * (unknown principal, invalid username, damaged record) the device-scoped
 * removal still drops whatever was remembered for this profile and target. Only
 * when no removal succeeds is the cleanup reported as failed.
 */

export function accountLogoutCleanupPlan({ principal, deviceId }) {
  const steps = [];
  if (typeof deviceId !== 'string' || !deviceId) return { steps };
  if (principal && typeof principal.username === 'string' && principal.username) {
    steps.push({ kind: 'identity', deviceId, username: principal.username });
  }
  steps.push({ kind: 'device', deviceId });
  return { steps };
}

/**
 * Runs the cleanup and returns the failure only when every step failed
 * (`null` otherwise, including when there was nothing to forget).
 */
export async function runAccountLogoutCleanup(plan, credentials, target) {
  let failure = null;
  for (const step of plan.steps) {
    try {
      if (step.kind === 'identity') {
        await credentials.forgetIdentity(
          { deviceId: step.deviceId, username: step.username },
          target
        );
      } else {
        await credentials.forgetDevice(step.deviceId, target);
      }
      return null;
    } catch (error) {
      failure = error;
    }
  }
  return failure;
}

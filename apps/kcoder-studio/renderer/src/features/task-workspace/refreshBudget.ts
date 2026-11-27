const REFRESH_BUDGET_MS = 8_000

/**
 * Bound one board refresh so a target whose app-server is gone cannot leave the
 * refresh affordance disabled forever. The failure stays visible afterwards.
 */
export async function withRefreshBudget<T>(work: Promise<T>, ms = REFRESH_BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TASK_REFRESH_TIMEOUT')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

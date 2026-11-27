/** Matches the existing Native history/branch/continuation worker capacity.
 * Each lane owns one independent job; repeated keys always stay ordered. */
export const MIGRATION_HISTORY_CONCURRENCY = 64

export async function runMigrationTasks<T>(
  items: readonly T[],
  options: { concurrency?: number; key: (item: T) => string; check: () => void },
  run: (item: T) => Promise<void>
): Promise<void> {
  const concurrency = options.concurrency ?? MIGRATION_HISTORY_CONCURRENCY
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MIGRATION_HISTORY_CONCURRENCY
  )
    throw new Error('migration_history_concurrency_invalid')
  const keyed = new Map<string, T[]>()
  for (const item of items) {
    const key = options.key(item),
      group = keyed.get(key)
    if (group) group.push(item)
    else keyed.set(key, [item])
  }
  const groups = [...keyed.values()]
  let cursor = 0,
    failed = false,
    failure: unknown
  const lane = async () => {
    try {
      while (!failed && cursor < groups.length) {
        options.check()
        const group = groups[cursor++]
        for (const item of group) {
          if (failed) return
          options.check()
          await run(item)
          options.check()
        }
      }
    } catch (cause) {
      if (!failed) {
        failed = true
        failure = cause
      }
    }
  }
  // Drain every admitted lane before the owner can start another run or clear cancellation slots.
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, lane))
  if (failed) throw failure
}

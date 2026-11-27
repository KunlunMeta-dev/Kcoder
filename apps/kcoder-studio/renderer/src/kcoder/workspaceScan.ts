export async function scanWorkspaces<T>(
  items: readonly T[],
  visit: (item: T) => Promise<void>,
  cancelled: () => boolean
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (!cancelled() && next < items.length) {
      const item = items[next++]
      await visit(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
}

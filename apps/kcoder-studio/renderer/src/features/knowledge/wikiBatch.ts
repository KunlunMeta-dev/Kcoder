export type BatchEntry<T, S> = {
  item: T
  source?: S
  status: 'pending' | 'uploading' | 'starting' | 'queued' | 'failed'
  error?: string
}

/** Preserve successful imports across retries and isolate failures per file. */
export async function runWikiBatch<T, S>(
  entries: BatchEntry<T, S>[],
  options: {
    current: () => boolean
    upload: (item: T, retry: boolean) => Promise<S>
    organize: (source: S) => Promise<unknown>
    changed: (entries: BatchEntry<T, S>[]) => void
  }
) {
  const result = entries.map(entry => ({ ...entry }))
  for (const entry of result) {
    if (!options.current()) break
    if (entry.status === 'queued') continue
    try {
      entry.error = undefined
      if (!entry.source) {
        const retry = entry.status === 'failed'
        entry.status = 'uploading'
        options.changed([...result])
        entry.source = await options.upload(entry.item, retry)
      }
      if (!options.current()) break
      entry.status = 'starting'
      options.changed([...result])
      await options.organize(entry.source)
      entry.status = 'queued'
    } catch (cause) {
      entry.status = 'failed'
      entry.error = cause instanceof Error ? cause.message : String(cause)
    }
    if (options.current()) options.changed(result.map(entry => ({ ...entry })))
  }
  return result
}

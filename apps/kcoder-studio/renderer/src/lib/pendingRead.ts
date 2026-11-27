export interface PendingRead<T> {
  controller: AbortController
  promise: Promise<T>
  subscribers: number
}

/** Share unfinished reads; each subscriber owns only its wait, never its peers. */
export function sharePendingRead<T>(
  reads: Map<string, PendingRead<T>>,
  key: string,
  signal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  let pending = reads.get(key)
  if (!pending) {
    const controller = new AbortController()
    pending = { controller, subscribers: 0, promise: Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return read(controller.signal)
    }) }
    reads.set(key, pending)
    const current = pending
    const retire = () => { if (reads.get(key) === current) reads.delete(key) }
    void pending.promise.then(retire, retire)
  }
  const current = pending
  current.subscribers++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      current.subscribers--
      if (current.subscribers === 0) {
        if (reads.get(key) === current) reads.delete(key)
        current.controller.abort()
      }
      callback()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    signal?.addEventListener('abort', abort, { once: true })
    current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

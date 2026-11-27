import { runtimeTransport } from './runtime-transport'

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<T> {
  const signal = options?.signal
  signal?.throwIfAborted()
  const response = Promise.resolve(
    runtimeTransport().handler(command, signal ? { ...args, signal } : args)
  ) as Promise<T>
  if (!signal) return response
  // Stop waiting without claiming that an already accepted operation was cancelled.
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    response.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
  })
}

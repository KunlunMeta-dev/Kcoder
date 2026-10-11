/** Keep snapshot reads sequential, scoped and quiet while the page is hidden. */
import i18n from 'i18next'

export interface SnapshotPollingOptions {
  poll: (isLive: () => boolean, signal: AbortSignal) => Promise<number | false>
  onError: (error: unknown) => void
  isCurrent: () => boolean
  active?: boolean
  retryDelayMs?: number
  timeoutMs?: number
  subscribe?: (refresh: () => void) => () => void
}

export function startSnapshotPolling(options: SnapshotPollingOptions) {
  let stopped = false
  let inFlight: AbortController | undefined
  let refreshPending = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const isLive = () => !stopped && options.isCurrent()
  const visible = () => document.visibilityState !== 'hidden'
  const enabled = () => isLive() && options.active !== false && visible()
  const schedule = (delay: number) => {
    clearTimeout(timer)
    if (enabled()) timer = setTimeout(() => void poll(), delay)
  }
  const poll = async () => {
    if (!enabled()) return
    if (inFlight) {
      refreshPending = true
      return
    }
    const controller = new AbortController()
    inFlight = controller
    const requestIsLive = () => isLive() && !controller.signal.aborted
    let delay: number | false = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let removeAbort: (() => void) | undefined
    try {
      // Even transports without AbortSignal support must release a foreground
      // snapshot that never returns. Late results retain an invalidated scope.
      delay = await Promise.race([
        options.poll(requestIsLive, controller.signal),
        new Promise<never>((_, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'))
          controller.signal.addEventListener('abort', abort, { once: true })
          removeAbort = () => controller.signal.removeEventListener('abort', abort)
          timeout = setTimeout(
            () => reject(new Error(i18n.t('common:rpcReadTimeout'))),
            options.timeoutMs ?? 30_000
          )
        }),
      ])
      if (requestIsLive()) failures = 0
    } catch (error) {
      if (requestIsLive()) {
        options.onError(error)
        delay = Math.round(
          Math.min(30_000, (options.retryDelayMs ?? 1000) * 2 ** Math.min(failures++, 5)) *
            (0.8 + Math.random() * 0.2)
        )
      }
    } finally {
      clearTimeout(timeout)
      removeAbort?.()
      controller.abort()
      if (inFlight === controller) {
        inFlight = undefined
        if (refreshPending) {
          refreshPending = false
          schedule(0)
        } else if (delay !== false) schedule(delay)
      }
    }
  }
  const abort = () => {
    const controller = inFlight
    inFlight = undefined
    refreshPending = false
    controller?.abort()
  }
  const refresh = () => {
    clearTimeout(timer)
    if (enabled()) void poll()
    else abort()
  }
  const unsubscribe = options.subscribe?.(refresh)
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('online', refresh)
  void poll()
  return () => {
    stopped = true
    abort()
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', refresh)
    window.removeEventListener('online', refresh)
    unsubscribe?.()
  }
}

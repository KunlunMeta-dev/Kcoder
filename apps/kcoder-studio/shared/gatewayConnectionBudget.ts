/** Per-WebView connection admission. Completed connections do not occupy slots. */
export class GatewayConnectionBudget {
  private active = 0
  private readonly waiting: Array<() => void> = []

  private readonly maximum: number
  private readonly queueLimit: number

  constructor(maximum = 4, queueLimit = 256) {
    this.maximum = maximum
    this.queueLimit = queueLimit
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Gateway connection cancelled')
    if (this.active >= this.maximum) {
      if (this.waiting.length >= this.queueLimit)
        throw new Error('Gateway connection queue is full')
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          const index = this.waiting.indexOf(start)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(new Error('Gateway connection cancelled'))
        }
        const start = () => {
          signal?.removeEventListener('abort', cancel)
          this.active++
          resolve()
        }
        this.waiting.push(start)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    } else this.active++
    try {
      if (signal?.aborted) throw new Error('Gateway connection cancelled')
      return await operation()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export const gatewayConnectionBudget = new GatewayConnectionBudget()

export function gatewayReconnectDelay(base: number, random = Math.random): number {
  return base <= 0 ? 0 : Math.floor(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5))
}

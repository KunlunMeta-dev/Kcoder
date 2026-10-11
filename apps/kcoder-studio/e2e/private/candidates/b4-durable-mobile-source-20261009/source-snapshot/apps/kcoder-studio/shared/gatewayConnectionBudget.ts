/** Per-WebView connection admission. Completed connections do not occupy slots. */
export class GatewayConnectionBudget {
  private active = 0
  private backgroundActive = 0
  private readonly waiting: Array<{ start: () => void; background: boolean }> = []

  private readonly maximum: number
  private readonly queueLimit: number

  constructor(maximum = 4, queueLimit = 256) {
    this.maximum = maximum
    this.queueLimit = queueLimit
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal, priority: 'foreground' | 'background' = 'foreground'): Promise<T> {
    const background = priority === 'background'
    if (signal?.aborted) throw new Error('Gateway connection cancelled')
    if (this.active >= this.maximum || (background && this.backgroundActive >= 1)) {
      if (this.waiting.length >= this.queueLimit)
        throw new Error('Gateway connection queue is full')
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(new Error('Gateway connection cancelled'))
        }
        const start = () => {
          signal?.removeEventListener('abort', cancel)
          this.active++
          if (background) this.backgroundActive++
          resolve()
        }
        const entry = { start, background }
        this.waiting.push(entry)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    } else {
      this.active++
      if (background) this.backgroundActive++
    }
    try {
      if (signal?.aborted) throw new Error('Gateway connection cancelled')
      return await operation()
    } finally {
      this.active--
      if (background) this.backgroundActive--
      while (this.active < this.maximum) {
        let index = this.waiting.findIndex((entry) => !entry.background)
        if (index < 0 && this.backgroundActive < 1) index = this.waiting.findIndex((entry) => entry.background)
        if (index < 0) break
        this.waiting.splice(index, 1)[0]!.start()
      }
    }
  }
}

export const gatewayConnectionBudget = new GatewayConnectionBudget()

export function gatewayReconnectDelay(base: number, random = Math.random): number {
  return base <= 0 ? 0 : Math.floor(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5))
}

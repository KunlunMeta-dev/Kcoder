// Workspace automation events can arrive through multiple clients of one renderer.
// Provider instance + thread + sequence identifies a wire event, not its text content.
export class NotificationReplayGuard {
  private readonly seen = new Set<string>()
  private readonly capacity: number
  constructor(capacity = 65536) {
    this.capacity = capacity
  }

  accept(method: string, params: Record<string, unknown>, target?: string): boolean {
    const { serverId, threadId, sequence } = params
    if (
      typeof serverId !== 'string' ||
      typeof threadId !== 'string' ||
      serverId.length > 256 ||
      threadId.length > 256 ||
      method.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0
    )
      return true
    const key = `${target ?? ''}\0${serverId}\0${threadId}\0${sequence}\0${method}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!)
    return true
  }
}

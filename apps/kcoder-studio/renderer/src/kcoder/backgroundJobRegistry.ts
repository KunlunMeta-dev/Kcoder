interface BackgroundJobScope {
  taskId: string
  serverId: string
  runId?: string
}

/** One current execution per target, parent task and agent. */
export class BackgroundJobRegistry<T extends BackgroundJobScope> {
  private readonly jobs = new Map<string, { agentId: string; job: T }>()

  private key(agentId: string, taskId: string, serverId: string): string {
    return JSON.stringify([serverId, taskId, agentId])
  }

  get(agentId: string, taskId: string, serverId: string): T | undefined {
    return this.jobs.get(this.key(agentId, taskId, serverId))?.job
  }

  set(agentId: string, job: T): void {
    this.jobs.set(this.key(agentId, job.taskId, job.serverId), { agentId, job })
  }

  delete(agentId: string, observed: T): boolean {
    const key = this.key(agentId, observed.taskId, observed.serverId)
    // An awaited projection may finish after a new run replaced its record.
    if (this.jobs.get(key)?.job !== observed) return false
    return this.jobs.delete(key)
  }

  *entries(): IterableIterator<[string, T]> {
    for (const { agentId, job } of this.jobs.values()) yield [agentId, job]
  }

  *values(): IterableIterator<T> {
    for (const { job } of this.jobs.values()) yield job
  }

  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.entries()
  }

  clear(): void {
    this.jobs.clear()
  }
}

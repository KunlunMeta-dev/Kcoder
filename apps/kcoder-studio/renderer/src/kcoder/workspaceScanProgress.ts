export interface WorkspaceScanUpdate<T> {
  revision: number
  complete: boolean
  snapshot: T
}

export class WorkspaceScanProgress<T> {
  private update: WorkspaceScanUpdate<T> | null = null
  private failure: Error | null = null
  private readonly readers = new Set<() => void>()

  publish(snapshot: T): void {
    if (this.failure || this.update?.complete) return
    this.update = { revision: (this.update?.revision ?? 0) + 1, complete: false, snapshot }
    this.wakeReaders()
  }

  finish(snapshot: T): void {
    if (this.failure || this.update?.complete) return
    this.update = { revision: (this.update?.revision ?? 0) + 1, complete: true, snapshot }
    this.wakeReaders()
  }

  fail(error: Error): void {
    if (this.failure || this.update?.complete) return
    this.failure = error
    this.wakeReaders()
  }

  async read(afterRevision: number): Promise<WorkspaceScanUpdate<T>> {
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      afterRevision > (this.update?.revision ?? 0)
    ) {
      throw new Error('Invalid workspace scan revision')
    }
    if (!this.failure && !this.update?.complete && afterRevision === (this.update?.revision ?? 0)) {
      await new Promise<void>(resolve => this.readers.add(resolve))
    }
    if (this.failure) throw this.failure
    if (!this.update) throw new Error('Workspace scan has no progress')
    return this.update
  }

  private wakeReaders(): void {
    const readers = [...this.readers]
    this.readers.clear()
    for (const resolve of readers) resolve()
  }
}

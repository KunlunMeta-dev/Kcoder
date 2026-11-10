import type { IntegrationScope, IntegrationTaskStateObservation } from '../../../shared/generated/contracts.integrations-core'
import { foldTaskStateObservation, isTaskStateObservation, sameTaskObservationScope } from '../../../shared/taskStateObservations.mjs'

type Read = <T>(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<T>

/** A disposable UI projection. All reads use the original scope/reference and
 * never create a task or treat an observation as execution authority. */
export class TaskStateEventConsumer {
  private readonly observations = new Map<string, IntegrationTaskStateObservation>()
  private scope: IntegrationScope | undefined
  private readonly cancel = new AbortController()
  private readonly read: Read
  private readonly isCurrent: () => boolean
  constructor(read: Read, isCurrent: () => boolean) { this.read = read; this.isCurrent = isCurrent }
  dispose() { this.cancel.abort(); this.observations.clear(); this.scope = undefined }

  async accept(incoming: unknown): Promise<IntegrationTaskStateObservation | null> {
    if (this.cancel.signal.aborted || !this.isCurrent() || !isTaskStateObservation(incoming)) return null
    if (!this.scope) {
      const scope = await this.read<IntegrationScope>('integrations/scope/read', {}, { signal: this.cancel.signal })
      if (this.cancel.signal.aborted || !this.isCurrent()) return null
      if (!sameTaskObservationScope(scope, incoming.scope)) return null
      this.scope = scope
    }
    const previous = this.observations.get(incoming.entityId)
    let result = foldTaskStateObservation(previous, incoming, this.scope)
    if (result.needsSnapshot) {
      const snapshot = await this.read<IntegrationTaskStateObservation>('integrations/runtime/readTaskState', {
        requestId: crypto.randomUUID(), scope: this.scope, reference: incoming.reference,
      }, { signal: this.cancel.signal })
      if (this.cancel.signal.aborted || !this.isCurrent() || !isTaskStateObservation(snapshot)
        || !snapshot.snapshot || snapshot.operationId !== incoming.operationId
        || snapshot.entityId !== incoming.entityId
        || ['threadId', 'turnId', 'taskId'].some(key =>
          snapshot.reference[key as keyof typeof snapshot.reference] !== incoming.reference[key as keyof typeof incoming.reference])) return null
      result = foldTaskStateObservation(this.observations.get(incoming.entityId), snapshot, this.scope)
    }
    if (this.cancel.signal.aborted || !this.isCurrent() || !result.changed || !result.observation) return null
    if (!this.observations.has(incoming.entityId) && this.observations.size >= 256)
      this.observations.delete(this.observations.keys().next().value!)
    this.observations.set(incoming.entityId, result.observation)
    return result.observation
  }
}

import { createResourceBudgetController } from './migrationResourceBudgetController.mjs'
import { validResourceCall } from './migrationResourceBudget'
import { HISTORY_RESOURCE_METHODS, validHistoryResourceCall } from './migrationHistoryResourceBudget'
import type * as C from './generated/contracts'
type Options = Omit<Parameters<typeof createResourceBudgetController>[0], 'api' | 'planId' | 'validIntent' | 'validView'> & {
  api: { read(input: C.MigrationHistoryResourceReadParams, options?: { signal?: AbortSignal }): Promise<C.MigrationHistoryResourceResult>; increase(input: C.MigrationHistoryResourceIncreaseParams): Promise<C.MigrationResourceIncreaseReceipt> }
}
/** The local plan discriminator only separates cache families; it never goes to Native. */
export function createHistoryResourceController(options: Options) {
  let observed: C.MigrationHistoryResourceResult | null = null
  const controller = createResourceBudgetController({
    ...options, scope: `history:${options.scope}`, planId: options.jobId,
    canIncrease: () => observed?.ownerJobId === options.jobId && (options.canIncrease?.() ?? true),
    api: {
      read: async (input, signal) => {
        const result = await options.api.read(input, signal)
        if (!validHistoryResourceCall(HISTORY_RESOURCE_METHODS.read, input, result)) throw new Error('migration_invalid_response')
        observed = result
        return result.budget
      },
      increase: ({ planId: _local, ...input }) => options.api.increase(input),
    },
    validIntent: value => {
      if (!value || typeof value !== 'object') return false
      const { planId, ...input } = value as Record<string, unknown>
      return planId === options.jobId && validHistoryResourceCall(HISTORY_RESOURCE_METHODS.increase, input)
    },
    validView: (query, view) => validResourceCall('migration/batch/resources/read', query, view),
  })
  return { ...controller, observed: () => observed }
}

/** A scoped lifetime is invalid until its committed layout effect installs the owner fence. */
export class HistoryBudgetLifetime {
  readonly key: unknown
  constructor(key: unknown) { this.key = key }
  private predicate: () => boolean = () => false
  private allowed = false
  update(predicate: () => boolean, allowed: boolean) { this.predicate = predicate; this.allowed = allowed }
  invalidate() { this.predicate = () => false; this.allowed = false }
  isCurrent = () => this.predicate()
  canIncrease = () => this.allowed
}

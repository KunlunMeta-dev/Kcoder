import { useState } from 'react'
import { KnowledgeOperationError, type KnowledgeIntegrationClient } from './client'
export function useDomainAction(refresh: () => void, client?: KnowledgeIntegrationClient) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<KnowledgeOperationError | undefined>()
  const inspect = async () => {
    if (!client || !error?.operationId || pending) return
    setPending(true)
    try {
      const result = await client.inspectOperation(error.operationId)
      if (['completed', 'rejected', 'cancelled'].includes(result.receipt.phase)) {
        setError(undefined)
        refresh()
      }
    } catch {
      /* Keep the original uncertain receipt until authoritative reconciliation succeeds. */
    } finally {
      setPending(false)
    }
  }
  return {
    pending,
    blocked: pending || !!error?.uncertain,
    error,
    inspect,
    run: async (action: () => Promise<unknown>) => {
      if (pending || error?.uncertain) return false
      setPending(true)
      setError(undefined)
      try {
        await action()
        refresh()
        return true
      } catch (reason) {
        setError(
          reason instanceof KnowledgeOperationError
            ? reason
            : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE')
        )
        return false
      } finally {
        setPending(false)
      }
    },
  }
}

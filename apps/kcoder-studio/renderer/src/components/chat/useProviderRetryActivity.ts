import { useEffect, useSyncExternalStore } from 'react'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'

export function useProviderRetryActivity(target?: string, task?: string) {
  useSyncExternalStore(
    toolPathPreviews.subscribe,
    toolPathPreviews.snapshot,
    toolPathPreviews.snapshot
  )
  useEffect(() => {
    if (target && task) return toolPathPreviews.acquire(target, task)
  }, [target, task])
  return toolPathPreviews.readProviderRetry(target, task)
}

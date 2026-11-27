import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'

const noSubscribe = () => () => {}
const noRetry = () => null

export function useProviderRetryActivity(target?: string, task?: string) {
  const visible = useRetainedPageVisible()
  const active = visible && Boolean(target && task)
  const subscribe = useCallback((listener: () => void) =>
    toolPathPreviews.subscribe(listener, target, task), [target, task])
  const read = useCallback(() => toolPathPreviews.readProviderRetry(target, task), [target, task])
  useEffect(() => {
    if (target && task) return toolPathPreviews.acquire(target, task)
  }, [target, task])
  return useSyncExternalStore(active ? subscribe : noSubscribe, read, noRetry)
}

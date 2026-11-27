import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import {
  findRuntimeTask,
  findRuntimeTaskWorkspace,
  isSameRuntimeTaskIdentity,
} from './workbenchRuntimeHelpers'
import { useWorkbench } from './useWorkbench'

function subscribeLocation(changed: () => void) {
  window.addEventListener('popstate', changed)
  return () => window.removeEventListener('popstate', changed)
}
const locationSnapshot = () => window.location.href

export function useRuntimeTaskRouteRestoration() {
  const { state, openRuntimeTask } = useWorkbench()
  const location = useSyncExternalStore(subscribeLocation, locationSnapshot)
  const routeRuntimeTask = useMemo(() => {
    if (state.isBootstrapping) return null

    const url = new URL(location)
    const route = parseRuntimeTaskRoute(stripAppBasePath(url.pathname), url.search)
    if (!route || isSameRuntimeTaskIdentity(state.currentRuntimeTask, route)) return null

    const runtimeTask = findRuntimeTask(state.runtimeWork, route)
    const workspace = findRuntimeTaskWorkspace(state.runtimeWork, route)
    return {
      ...route,
      ...(workspace?.workspacePath ? { workspacePath: workspace.workspacePath } : {}),
      ...(runtimeTask?.threadId ? { threadId: runtimeTask.threadId } : {}),
      ...(runtimeTask?.runtimeHandle ? { runtimeHandle: runtimeTask.runtimeHandle } : {}),
    }
  }, [location, state.currentRuntimeTask, state.isBootstrapping, state.runtimeWork])

  const attempted = useRef<string | null>(null)
  useEffect(() => {
    if (!routeRuntimeTask) {
      attempted.current = null
      return
    }
    const identity = JSON.stringify([
      location,
      routeRuntimeTask.deviceId,
      routeRuntimeTask.taskId,
      routeRuntimeTask.workspacePath,
    ])
    if (attempted.current === identity) return
    attempted.current = identity
    // Restoring a link selects its original task without replacing its owning page.
    void openRuntimeTask(routeRuntimeTask, { navigate: false }).catch(() => {
      // The task/transcript owner renders its failure; do not replay on unrelated list updates.
      console.warn('[KCoder] Original task route could not be restored')
    })
  }, [location, openRuntimeTask, routeRuntimeTask])

  return routeRuntimeTask
}

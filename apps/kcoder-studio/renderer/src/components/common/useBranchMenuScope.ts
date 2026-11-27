import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import type { WorkspaceTarget } from '@/types/workspace-files'

export type BranchMenuTarget = Pick<WorkspaceTarget, 'deviceId' | 'path'>

/** Display ownership only; Git commands still use their original Native authority. */
export function useBranchMenuScope(target?: BranchMenuTarget | null) {
  const [revision, setRevision] = useState(0)
  const deviceId = target?.deviceId
  const key = JSON.stringify([deviceId, target?.path, revision])
  const scope = useMemo(() => ({ key }), [key])
  const owner = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    owner.current = scope
    return () => {
      owner.current = null
    }
  }, [scope])
  useLayoutEffect(() => {
    const invalidate = (id?: string) => {
      if (deviceId && id && id !== deviceId) return
      owner.current = null
      setRevision(value => value + 1)
    }
    const stop = listenAccountContextChanges(invalidate)
    const changed = (event: Event) => {
      invalidate((event as CustomEvent<{ targetId?: string }>).detail?.targetId)
    }
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      stop()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [deviceId])
  const isCurrent = useCallback(() => owner.current === scope, [scope])
  return { key, isCurrent }
}

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkspaceFileEditorGuard,
  WorkspaceFileEditorNavigation,
} from '@/types/workspace-files'
import { captureAccountContextRevision } from './accountContextEvents'

interface Registration {
  identity: object
  guard: WorkspaceFileEditorGuard
}

/** Routes parent navigation to the mounted editor's existing unsaved dialog. */
export function useWorkspaceFileEditorGuard(
  scope: string,
  ownerDeviceId?: string
): WorkspaceFileEditorNavigation {
  const identity = useMemo(() => ({ scope, ownerDeviceId }), [scope, ownerDeviceId])
  const latestIdentity = useRef(identity)
  const mounted = useRef(true)
  const registered = useRef<Registration | null>(null)
  const [state, setState] = useState<Registration | null>(null)
  useLayoutEffect(() => {
    latestIdentity.current = identity
  }, [identity])
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      registered.current = null
    }
  }, [])
  const register = useCallback(
    (guard: WorkspaceFileEditorGuard) => {
      if (!mounted.current || latestIdentity.current !== identity) return () => {}
      const entry = { identity, guard }
      registered.current = entry
      setState(entry)
      return () => {
        if (registered.current !== entry) return
        registered.current = null
        if (mounted.current) setState(current => (current === entry ? null : current))
      }
    },
    [identity]
  )
  const request = useCallback(
    (action: () => void) => {
      if (!mounted.current || latestIdentity.current !== identity) return
      const accountCurrent = captureAccountContextRevision()
      const entry = registered.current
      const isCurrent = () =>
        mounted.current &&
        latestIdentity.current === identity &&
        (!ownerDeviceId || accountCurrent(ownerDeviceId)) &&
        (!entry?.guard.deviceId || accountCurrent(entry.guard.deviceId))
      if (!isCurrent()) return
      if (!entry || entry.identity !== identity) {
        action()
        return
      }
      entry.guard.navigate(() => {
        if (
          isCurrent() &&
          registered.current?.identity === identity &&
          registered.current.guard.owner === entry.guard.owner
        )
          action()
      })
    },
    [identity, ownerDeviceId]
  )
  return useMemo(
    () => ({ dirty: state?.identity === identity && state.guard.dirty, register, request }),
    [identity, state, register, request]
  )
}

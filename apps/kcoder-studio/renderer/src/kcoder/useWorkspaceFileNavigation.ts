import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import type { WorkspaceFileOpenRequest, WorkspaceTarget } from '@/types/workspace-files'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'

interface FileNavigationState {
  scope: string
  request: WorkspaceFileOpenRequest | null
  committedTarget: WorkspaceTarget | null
  committedId: number | null
}

/** Keep proposed file targets separate from the editor's accepted target. */
export function useWorkspaceFileNavigation(
  ownerScope: string,
  fallbackTarget: WorkspaceTarget | null,
  ownerDeviceId = fallbackTarget?.deviceId
) {
  const [accountEpoch, setAccountEpoch] = useState(0)
  const scope = `${ownerScope}\0${accountEpoch}`
  const [state, setState] = useState<FileNavigationState>(() => ({
    scope,
    request: null,
    committedTarget: null,
    committedId: null,
  }))
  const active = useMemo(
    () =>
      state.scope === scope
        ? state
        : {
            scope,
            request: null,
            committedTarget: null,
            committedId: null,
          },
    [scope, state]
  )
  // Reset during the owner transition so no old request is rendered in its place.
  if (state.scope !== scope) setState(active)
  const latest = useRef(active)
  const fallback = useRef(fallbackTarget)
  const ownerDevice = useRef(ownerDeviceId)
  const sequence = useRef(0)
  useLayoutEffect(() => {
    latest.current = active
    fallback.current = fallbackTarget
    ownerDevice.current = ownerDeviceId
  }, [active, fallbackTarget, ownerDeviceId])
  useLayoutEffect(() => {
    sequence.current++
  }, [scope])

  useEffect(
    () =>
      listenAccountContextChanges(targetId => {
        const current = latest.current
        if (
          targetId === ownerDevice.current ||
          targetId === fallback.current?.deviceId ||
          targetId === current.committedTarget?.deviceId
        ) {
          sequence.current++
          setAccountEpoch(epoch => epoch + 1)
        } else if (targetId === current.request?.target?.deviceId) {
          sequence.current++
          setState(value => ({ ...value, request: null }))
        }
      }),
    []
  )

  const beginFileOpenRequest = useCallback(() => {
    const id = latest.current.scope === scope ? ++sequence.current : -1
    const accountIsCurrent = captureAccountContextRevision()
    return {
      id,
      isCurrent: (targetId?: string) =>
        id >= 0 &&
        latest.current.scope === scope &&
        sequence.current === id &&
        (!targetId || accountIsCurrent(targetId)),
    }
  }, [scope])

  const setOpenFileRequest = useCallback(
    (update: SetStateAction<WorkspaceFileOpenRequest | null>) => {
      if (latest.current.scope !== scope) return
      if (update === null) sequence.current++
      setState(current => {
        if (current.scope !== scope) return current
        const proposed = typeof update === 'function' ? update(current.request) : update
        if (proposed && proposed.isCurrent?.() === false) return current
        return {
          ...current,
          request: proposed
            ? { ...proposed, target: proposed.target ?? fallbackTarget ?? undefined }
            : null,
          ...(proposed ? {} : { committedTarget: null, committedId: null }),
        }
      })
    },
    [fallbackTarget, scope]
  )

  const commitFileOpenRequest = useCallback(
    (request: WorkspaceFileOpenRequest): boolean => {
      const current = latest.current
      if (
        current.scope !== scope ||
        current.request?.id !== request.id ||
        current.request.path !== request.path ||
        request.isCurrent?.() === false
      )
        return false
      if (current.committedId === request.id) return true
      setState(value =>
        value.scope === scope && value.request?.id === request.id
          ? { ...value, committedTarget: request.target ?? fallbackTarget, committedId: request.id }
          : value
      )
      return true
    },
    [fallbackTarget, scope]
  )

  const cancelFileOpenRequest = useCallback(
    (request: WorkspaceFileOpenRequest) => {
      if (latest.current.scope !== scope || latest.current.request?.id !== request.id) return
      sequence.current++
      setState(value =>
        value.scope === scope && value.request?.id === request.id
          ? { ...value, request: null }
          : value
      )
    },
    [scope]
  )

  return {
    cancelFileOpenRequest,
    fileNavigationScope: scope,
    openFileRequest: active.request,
    committedFileWorkspaceTarget: active.committedTarget,
    setOpenFileRequest,
    beginFileOpenRequest,
    commitFileOpenRequest,
  }
}

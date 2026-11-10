import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFileCommentController, WorkspaceFileCommentDraft, WorkspaceTarget } from '@/types/workspace-files'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'

const MAX_TARGETS = 32
const MAX_BYTES = 8 * 1024 * 1024
const MAX_COMMENT_LENGTH = 8192

interface Entry {
  deviceId: string
  ownerDeviceId?: string
  draft: WorkspaceFileCommentDraft
}

interface DraftState {
  entries: Record<string, Entry>
  capacityTarget: string | null
}

function reservedBytes(draft: WorkspaceFileCommentDraft): number {
  // Reserve the entire comment allowance when selecting a source, so typing
  // within the UI limit cannot later fail because another target has a draft.
  return (Object.values(draft).reduce<number>((total, value) =>
    total + (typeof value === 'string' ? value.length : 0), 0)
    - draft.comment.length + MAX_COMMENT_LENGTH) * 2
}

/** Keep feedback next to the existing owner-scoped file navigation state. */
export function useWorkspaceFileCommentDrafts(
  scope: string,
  target: WorkspaceTarget | null,
  ownerDeviceId?: string,
) {
  const [state, setState] = useState<DraftState>(() => ({ entries: {}, capacityTarget: null }))
  const active = state
  const key = target ? JSON.stringify([scope, target.deviceId, target.path]) : ''
  const ownerToken = useMemo(() => ({ scope, key }), [scope, key])
  const latestOwnerToken = useRef(ownerToken)
  const latest = useRef(active)
  const currentKey = useRef(key)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    latest.current = active
    currentKey.current = key
    latestOwnerToken.current = ownerToken
  }, [active, key, ownerToken])
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => listenAccountContextChanges(deviceId => {
    const current = latest.current
    const entries = Object.fromEntries(Object.entries(current.entries).filter(([, entry]) => entry.deviceId !== deviceId && entry.ownerDeviceId !== deviceId))
    if (Object.keys(entries).length === Object.keys(current.entries).length) return
    const next = { ...current, entries, capacityTarget: null }
    latest.current = next
    setState(next)
  }), [])

  const draft = active.entries[key]?.draft ?? null
  const deviceId = target?.deviceId
  const controller = useMemo<WorkspaceFileCommentController>(() => {
    const accountCurrent = captureAccountContextRevision()
    const isCurrent = () => mounted.current && !!deviceId &&
      latestOwnerToken.current === ownerToken && currentKey.current === key &&
      (latest.current.entries[key]?.draft ?? null) === draft &&
      accountCurrent(deviceId) && (!ownerDeviceId || accountCurrent(ownerDeviceId))
    return {
      draft,
      capacityExceeded: active.capacityTarget === key,
      isCurrent,
      setDraft: nextDraft => {
        if (!isCurrent() || !deviceId) return false
        const current = latest.current
        const entries = { ...current.entries }
        if (nextDraft) {
          if (nextDraft.comment.length > MAX_COMMENT_LENGTH) return false
          entries[key] = { deviceId, ownerDeviceId, draft: nextDraft }
          if (Object.keys(entries).length > MAX_TARGETS ||
              Object.values(entries).reduce((bytes, entry) => bytes + reservedBytes(entry.draft), 0) > MAX_BYTES) {
            const rejected = { ...current, capacityTarget: key }
            latest.current = rejected
            setState(rejected)
            return false
          }
        } else delete entries[key]
        const next = { entries, capacityTarget: null }
        latest.current = next
        setState(next)
        return true
      },
    }
  }, [active.capacityTarget, deviceId, draft, key, ownerDeviceId, ownerToken])
  return { fileCommentController: controller, hasFileCommentDrafts: Object.keys(active.entries).length > 0 }
}

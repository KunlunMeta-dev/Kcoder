import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { captureAccountContextRevision, listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import type { CodeCommentContext } from '@/types/workspace-files'

interface Entry { deviceId?: string; comments: CodeCommentContext[] }
interface State { entries: Record<string, Entry>; epochs: Record<string, number> }

function accountEpoch(epochs: State['epochs'], key: string) {
  return typeof epochs[key] === 'number' ? epochs[key] : 0
}

export function retireSubmittedComments(current: CodeCommentContext[], submitted: CodeCommentContext[]) {
  return current.filter(comment => !submitted.includes(comment))
}

export function restoreSubmittedComments(current: CodeCommentContext[], submitted: CodeCommentContext[]) {
  const currentIds = new Set(current.map(comment => comment.id))
  return [...submitted.filter(comment => !currentIds.has(comment.id)), ...current]
}

/** Retain unsent feedback with its pane destination, including a blank chat. */
export function usePaneCommentContexts(ownerScope: string, deviceId?: string) {
  const key = JSON.stringify([ownerScope, deviceId ?? null])
  const [state, setState] = useState<State>({ entries: {}, epochs: {} })
  const latest = useRef(state)
  const owner = useRef({ key, deviceId })
  const mounted = useRef(false)
  useLayoutEffect(() => { latest.current = state; owner.current = { key, deviceId } }, [deviceId, key, state])
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => listenAccountContextChanges(targetId => {
    const current = latest.current
    const entries = Object.fromEntries(Object.entries(current.entries).filter(([, entry]) =>
      entry.deviceId !== targetId && entry.deviceId !== undefined))
    const epochs = { ...current.epochs, [targetId]: accountEpoch(current.epochs, targetId) + 1,
      '': accountEpoch(current.epochs, '') + 1 }
    const next = { entries, epochs }
    latest.current = next
    setState(next)
  }), [])
  const epoch = accountEpoch(state.epochs, deviceId ?? '')
  const authority = useMemo(() => ({ key, deviceId, epoch, accountCurrent: captureAccountContextRevision() }), [deviceId, epoch, key])
  const currentAuthority = useRef(authority)
  useLayoutEffect(() => { currentAuthority.current = authority }, [authority])
  const setCodeCommentContexts = useCallback((update: SetStateAction<CodeCommentContext[]>) => {
    const current = latest.current
    if (!mounted.current || currentAuthority.current !== authority || owner.current.key !== authority.key ||
        accountEpoch(current.epochs, authority.deviceId ?? '') !== authority.epoch ||
        (authority.deviceId && !authority.accountCurrent(authority.deviceId))) return
    const previous = current.entries[authority.key]?.comments ?? []
    const comments = typeof update === 'function' ? update(previous) : update
    const entries = { ...current.entries }
    if (comments.length) entries[authority.key] = { deviceId: authority.deviceId, comments }
    else delete entries[authority.key]
    const next = { ...current, entries }
    latest.current = next
    setState(next)
  }, [authority])
  return {
    codeCommentContexts: state.entries[key]?.comments ?? [],
    setCodeCommentContexts,
    hasCodeCommentDrafts: Object.values(state.entries).some(entry => entry.comments.length > 0),
  }
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { createMigrationApi } from './gatewayMigration'
import type { MigrationHistorySearchHit } from '../../../shared/generated/contracts'

type Phase = 'idle' | 'running' | 'ready' | 'paused' | 'failed'
interface Session {
  id: string
  query: string
  caseSensitive: boolean
  starts: Array<string | undefined>
  cursor: string | undefined
  items: MigrationHistorySearchHit[]
  total: number
  scanned: number
  bytes: number
  done: boolean
  unsupported: number
  excluded: number
}
/** Search is an abortable observation. Only confirmed cursors are retained for the next read. */
export function useMigrationSearch(
  deviceId: string,
  workspacePath: string | undefined,
  jobId: string,
  viewId: string | undefined,
  isCurrent: () => boolean
) {
  const [account, setAccount] = useState(0)
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const scope = useMemo(
    () => ({ api, jobId, viewId, account, valid: captureAccountContextRevision() }),
    [api, jobId, viewId, account]
  )
  const owner = useRef(scope),
    mounted = useRef(false),
    current = useRef(isCurrent),
    epoch = useRef(0)
  const request = useRef<AbortController | null>(null),
    session = useRef<Session | null>(null)
  const [state, setState] = useState({
    scope,
    phase: 'idle' as Phase,
    error: '',
    value: null as Session | null,
  })
  useLayoutEffect(() => {
    current.current = isCurrent
  }, [isCurrent])
  useLayoutEffect(() => {
    owner.current = scope
    mounted.current = true
    session.current = null
    epoch.current++
    return () => {
      if (owner.current === scope) {
        mounted.current = false
        request.current?.abort()
      }
    }
  }, [scope])
  useEffect(
    () =>
      listenAccountContextChanges(target => {
        if (target === deviceId) setAccount(value => value + 1)
      }),
    [deviceId]
  )
  const valid = useCallback(
    () => mounted.current && owner.current === scope && scope.valid(deviceId) && current.current(),
    [scope, deviceId]
  )
  const scan = async (start: Session) => {
    if (!valid()) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const generation = ++epoch.current
    let active = start
    session.current = active
    if (active.done || active.items.length >= 10) {
      setState({ scope, phase: 'ready', error: '', value: active })
      return
    }
    setState({ scope, phase: 'running', error: '', value: active })
    const owns = () => valid() && !controller.signal.aborted && generation === epoch.current
    try {
      while (owns()) {
        const cursor = active.cursor
        const result = await api.historySearch(
          {
            jobId,
            viewId: viewId ?? null,
            query: active.query,
            caseSensitive: active.caseSensitive,
            cursor: cursor ?? null,
            limit: 10 - active.items.length,
          },
          { signal: controller.signal }
        )
        if (!owns()) return
        if (
          result.items.length > 10 - active.items.length ||
          (result.nextCursor === cursor && cursor !== undefined)
        )
          throw new Error('history_search_cursor_stalled')
        active = {
          ...active,
          items: [...active.items, ...result.items],
          cursor: result.nextCursor ?? undefined,
          done: result.nextCursor == null,
          total: result.totalRecords,
          scanned: result.scannedRecords,
          bytes: result.processedBytes,
          unsupported: result.unsupportedBlocks,
          excluded: result.excludedBlocks,
        }
        session.current = active
        const done = active.done || active.items.length >= 10
        setState({ scope, phase: done ? 'ready' : 'running', error: '', value: active })
        if (done) return
      }
    } catch (cause) {
      if (owns())
        setState({
          scope,
          phase: 'failed',
          value: active,
          error:
            (cause instanceof Error ? cause.message : '').match(
              /\b(?:migration|history|external_history)_[a-z_]+\b/
            )?.[0] ?? 'error',
        })
    }
  }
  const search = (query: string, caseSensitive: boolean) =>
    scan({
      id: crypto.randomUUID(),
      query,
      caseSensitive,
      starts: [undefined],
      cursor: undefined,
      items: [],
      total: 0,
      scanned: 0,
      bytes: 0,
      done: false,
      unsupported: 0,
      excluded: 0,
    })
  const cancel = () => {
    request.current?.abort()
    epoch.current++
    if (valid()) setState({ scope, phase: 'paused', error: '', value: session.current })
  }
  const resume = () => {
    if (session.current) void scan(session.current)
  }
  const next = () => {
    const value = session.current
    if (!value || value.done || !value.cursor) return
    void scan({ ...value, starts: [...value.starts, value.cursor], items: [] })
  }
  const previous = () => {
    const value = session.current
    if (!value || value.starts.length < 2) return
    const starts = value.starts.slice(0, -1)
    void scan({ ...value, starts, cursor: starts.at(-1), items: [], done: false })
  }
  const active = state.scope === scope && scope.valid(deviceId) && isCurrent()
  return {
    phase: active ? state.phase : 'idle',
    error: active ? state.error : '',
    value: active ? state.value : null,
    search,
    cancel,
    resume,
    next,
    previous,
  }
}

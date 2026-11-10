import { useCallback, useEffect, useRef, useState } from 'react'
import { KnowledgeOperationError } from './client'
type Cursor = string | undefined
const initialCursors: Cursor[] = [undefined]
export function useDomainPage<T>(
  ownerKey: string,
  load: (
    after?: string,
    signal?: AbortSignal
  ) => Promise<{ items: T[]; nextCursor?: string | null }>
) {
  const [navigation, setNavigation] = useState({ ownerKey, cursors: initialCursors })
  const [refreshKey, setRefreshKey] = useState(0)
  const [projection, setProjection] = useState<{
    key: string
    ownerKey: string
    items: T[]
    nextCursor?: string
    error?: KnowledgeOperationError
  }>()
  const generation = useRef(0)
  const loadRef = useRef(load)
  const cursors = navigation.ownerKey === ownerKey ? navigation.cursors : initialCursors
  const after = cursors.at(-1)
  const key = JSON.stringify([ownerKey, after, refreshKey])
  useEffect(() => {
    loadRef.current = load
  }, [load])
  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    void loadRef
      .current(after, controller.signal)
      .then(page => {
        if (!controller.signal.aborted && current === generation.current)
          setProjection({
            key,
            ownerKey,
            items: page.items.slice(0, 10),
            nextCursor: page.nextCursor ?? undefined,
          })
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && current === generation.current)
          setProjection(() => ({
            key,
            ownerKey,
            items: [],
            error:
              reason instanceof KnowledgeOperationError
                ? reason
                : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE'),
          }))
      })
    return () => {
      controller.abort()
    }
  }, [ownerKey, after, key])
  const refresh = useCallback(() => setRefreshKey(n => n + 1), [])
  const owned = projection?.ownerKey === ownerKey ? projection : undefined
  const pending = owned?.key !== key
  return {
    items: owned?.items ?? [],
    pending,
    error: pending ? undefined : owned?.error,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    hasNext: !pending && !!owned?.nextCursor,
    previous: () =>
      setNavigation({ ownerKey, cursors: cursors.length > 1 ? cursors.slice(0, -1) : cursors }),
    next: () => {
      if (!pending && owned?.nextCursor)
        setNavigation({ ownerKey, cursors: [...cursors, owned.nextCursor] })
    },
    refresh,
  }
}

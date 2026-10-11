import { useCallback, useEffect, useRef, useState } from 'react'
import type { WikiPageList } from '@/kcoder/knowledgeApi'

export const WIKI_CATALOG_PAGE_SIZE = 10

type Catalog<T> = {
  scope: string
  items: T[]
  cursor: string | null
  pageIndex: number
  loading: boolean
  error: string
}

const lastPage = (count: number) => Math.max(0, Math.ceil(count / WIKI_CATALOG_PAGE_SIZE) - 1)

export function useWikiCatalog<T>({
  scope,
  load,
  isCurrent,
  refreshSignal,
  project,
}: {
  scope: string
  load: (afterId?: string) => Promise<WikiPageList<T>>
  isCurrent: () => boolean
  refreshSignal: number
  project: (items: T[]) => T[]
}) {
  const initial: Catalog<T> = {
    scope,
    items: [],
    cursor: null,
    pageIndex: 0,
    loading: true,
    error: '',
  }
  const [catalog, setCatalog] = useState(initial)
  const current = useRef(initial)
  const revision = useRef(0)
  const navigation = useRef(0)
  const projection = useRef(project)
  useEffect(() => {
    projection.current = project
  }, [project])
  const publish = useCallback((value: Catalog<T>) => {
    current.current = value
    setCatalog(value)
  }, [])

  useEffect(() => {
    let alive = true
    const lifetime = revision
    const attempt = ++lifetime.current
    const valid = () => alive && isCurrent() && attempt === lifetime.current
    const previous = current.current
    const sameScope = previous.scope === scope
    // Rebuild visited entries from the first cursor: new IDs can precede old cursors.
    const extent = sameScope
      ? Math.max(WIKI_CATALOG_PAGE_SIZE, previous.items.length)
      : WIKI_CATALOG_PAGE_SIZE
    queueMicrotask(() => {
      if (!valid()) return
      publish({
        scope,
        items: sameScope ? previous.items : [],
        cursor: sameScope ? previous.cursor : null,
        pageIndex: sameScope ? previous.pageIndex : 0,
        loading: true,
        error: '',
      })
      void (async () => {
        const items: T[] = []
        let cursor: string | null = null
        do {
          const result = await load(cursor ?? undefined)
          if (!valid()) return
          items.push(...result.items)
          const next = result.items.length ? (result.nextAfterId ?? null) : null
          if (next && next === cursor) throw new Error('Wiki catalog cursor did not advance')
          cursor = next
        } while (cursor && items.length < extent)
        if (!valid()) return
        publish({
          scope,
          items,
          cursor,
          pageIndex: Math.min(
            current.current.pageIndex,
            lastPage(projection.current(items).length)
          ),
          loading: false,
          error: '',
        })
      })().catch(cause => {
        if (valid())
          publish({
            ...current.current,
            loading: false,
            error: String(cause instanceof Error ? cause.message : cause),
          })
      })
    })
    return () => {
      alive = false
      ++lifetime.current
    }
  }, [scope, load, isCurrent, refreshSignal, publish])

  const owned = catalog.scope === scope ? catalog : initial
  const projected = project(owned.items)
  const pageIndex = Math.min(owned.pageIndex, lastPage(projected.length))
  const reset = () => {
    ++navigation.current
    publish({ ...current.current, pageIndex: 0 })
  }
  const previous = () => {
    if (!owned.loading) publish({ ...current.current, pageIndex: Math.max(0, pageIndex - 1) })
  }
  const next = async () => {
    const before = current.current
    if (before.scope !== scope || before.loading) return
    const desiredPage =
      (pageIndex + 1) * WIKI_CATALOG_PAGE_SIZE <= projected.length ? pageIndex + 1 : pageIndex
    const desiredExtent = (desiredPage + 1) * WIKI_CATALOG_PAGE_SIZE
    if (desiredExtent <= projected.length || !before.cursor) {
      publish({ ...before, pageIndex: desiredPage })
      return
    }
    if (!before.cursor) return
    const attempt = revision.current
    const movement = navigation.current
    const valid = () => isCurrent() && attempt === revision.current
    publish({ ...before, loading: true, error: '' })
    try {
      const items = [...before.items]
      let cursor: string | null = before.cursor
      do {
        const result = await load(cursor)
        if (!valid()) return
        items.push(...result.items)
        const nextCursor = result.items.length ? (result.nextAfterId ?? null) : null
        if (nextCursor && nextCursor === cursor)
          throw new Error('Wiki catalog cursor did not advance')
        cursor = nextCursor
      } while (cursor && movement === navigation.current && project(items).length < desiredExtent)
      // Cache the complete response, even if an older target returns more than requested.
      const available = project(items)
      publish({
        scope,
        items,
        cursor,
        pageIndex:
          movement === navigation.current
            ? Math.min(desiredPage, lastPage(available.length))
            : current.current.pageIndex,
        loading: false,
        error: '',
      })
    } catch (cause) {
      if (valid())
        publish({
          ...current.current,
          loading: false,
          error: String(cause instanceof Error ? cause.message : cause),
        })
    }
  }
  return {
    ...owned,
    pageIndex,
    visibleItems: projected.slice(
      pageIndex * WIKI_CATALOG_PAGE_SIZE,
      (pageIndex + 1) * WIKI_CATALOG_PAGE_SIZE
    ),
    hasNext: (pageIndex + 1) * WIKI_CATALOG_PAGE_SIZE < projected.length || !!owned.cursor,
    reset,
    previous,
    next,
  }
}

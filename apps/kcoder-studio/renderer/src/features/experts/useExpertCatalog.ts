import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OfficeAssistantItem, OfficeList } from '@/features/office-integration/controller'
import type { OfficeMarketExpert } from '../../../../shared/generated/contracts'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { ExpertClient } from './client'
import { marketPresentation } from './presentation'

export type ExpertTab = 'mine' | 'teams' | 'library' | 'market'
type Resource = 'personal' | 'library' | 'market'
interface Data {
  personal: OfficeAssistantItem[]
  library: OfficeAssistantItem[]
  market: { items: OfficeMarketExpert[]; scenes: string[] }
}
interface ReadState<T> {
  data: T
  key: string
  loaded: boolean
  loading: boolean
  error: boolean
}
interface Scope {
  client: ExpertClient
  language: string
}
type Catalog = { scope: Scope } & { [K in Resource]: ReadState<Data[K]> }
interface ReadRequest {
  key: string
  controller: AbortController
  signal: AbortSignal
  promise: Promise<void>
}

function initialCatalog(scope: Scope): Catalog {
  const state = { key: '', loaded: false, loading: false, error: false }
  return {
    scope,
    personal: { ...state, data: [] },
    library: { ...state, data: [] },
    market: { ...state, data: { items: [], scenes: [] } },
  }
}

async function readExperts(
  client: ExpertClient,
  language: string,
  personal: boolean,
  signal: AbortSignal
) {
  const all: OfficeAssistantItem[] = []
  let cursor: string | undefined
  for (let page = 0; page < 32; page++) {
    const result = await client.controller.call<OfficeList<OfficeAssistantItem>>(
      'assistant/list',
      { limit: 10, language, personalOnly: personal, ...(cursor ? { cursor } : {}) },
      undefined,
      signal
    )
    signal.throwIfAborted()
    if (
      !Array.isArray(result.items) ||
      result.items.some(item => !isContract('OfficeAssistantDefinition', item.definition))
    )
      throw new Error('OFFICE_INVALID_REPLY')
    all.push(...result.items)
    if (!result.nextCursor) return all.filter(item => (personal ? !item.builtin : item.builtin))
    cursor = result.nextCursor
  }
  throw new Error('OFFICE_CATALOG_PAGE_LIMIT')
}

const sceneOrder = [
  'ecommerce',
  'finance',
  'content-creation',
  'lifestyle',
  'marketing',
  'mysticism',
  'academic',
  'legal',
  'tech',
  'education',
  'healthcare',
  'hr',
  'media',
  'design',
]

async function readMarket(
  client: ExpertClient,
  language: string,
  query: string,
  scene: string,
  signal: AbortSignal
) {
  const items: OfficeMarketExpert[] = []
  let cursor: string | undefined
  const scenes = new Set<string>()
  for (let page = 0; page < 20; page++) {
    const result = await client.market(query, query ? '' : scene, cursor, language, signal)
    signal.throwIfAborted()
    if (
      !Array.isArray(result.items) ||
      result.items.some(item => !isContract('OfficeMarketExpert', item)) ||
      !Array.isArray(result.scenes)
    )
      throw new Error('OFFICE_INVALID_REPLY')
    items.push(...result.items)
    result.scenes.forEach(value => scenes.add(value))
    if (!result.nextCursor) {
      items.sort(
        (a, b) => marketPresentation(a, language).rank - marketPresentation(b, language).rank
      )
      return {
        items,
        scenes: [...scenes].sort((a, b) => sceneOrder.indexOf(a) - sceneOrder.indexOf(b)),
      }
    }
    cursor = result.nextCursor
  }
  throw new Error('OFFICE_CATALOG_PAGE_LIMIT')
}

/** Page-local read projections; mutations still use the original target controller. */
export function useExpertCatalog(
  client: ExpertClient,
  language: string,
  tab: ExpertTab,
  query: string,
  scene: string
) {
  const scope = useMemo(() => ({ client, language }), [client, language])
  const manager = useMemo(() => ({ scope, requests: new Map<Resource, ReadRequest>() }), [scope])
  const owner = useRef<Scope | null>(null)
  const [stored, setStored] = useState(() => initialCatalog(scope))
  // A new client/language must never render the previous owner's list while its effect starts.
  const catalog = stored.scope === scope ? stored : initialCatalog(scope)
  const resource: Resource =
    tab === 'market' ? 'market' : tab === 'library' ? 'library' : 'personal'
  const marketKey = JSON.stringify([query, query ? '' : scene])

  useEffect(() => {
    owner.current = scope
    return () => {
      if (owner.current === scope) owner.current = null
      manager.requests.forEach(request => request.controller.abort())
    }
  }, [manager, scope])

  const read = useCallback(
    <K extends Resource>(
      kind: K,
      key: string,
      loader: (signal: AbortSignal) => Promise<Data[K]>,
      force = false,
      parentSignal?: AbortSignal
    ): Promise<void> => {
      if (owner.current !== scope) return Promise.reject(new Error('OFFICE_CATALOG_OWNER_CHANGED'))
      parentSignal?.throwIfAborted()
      const previous = manager.requests.get(kind)
      if (!force && previous?.key === key && !previous.signal.aborted) return previous.promise
      previous?.controller.abort()
      const controller = new AbortController()
      const signal = parentSignal
        ? AbortSignal.any([controller.signal, parentSignal])
        : controller.signal
      const request: ReadRequest = { key, controller, signal, promise: Promise.resolve() }
      manager.requests.set(kind, request)
      const current = () =>
        owner.current === scope && !signal.aborted && manager.requests.get(kind) === request
      const update = (patch: Partial<ReadState<Data[K]>>) => {
        if (!current()) return
        setStored(old => {
          if (!current()) return old
          const base = old.scope === scope ? old : initialCatalog(scope)
          return { ...base, [kind]: { ...base[kind], ...patch } }
        })
      }
      update({ key, loading: true, error: false })
      request.promise = (async () => {
        try {
          const data = await loader(signal)
          signal.throwIfAborted()
          update({ data, loaded: true, loading: false, error: false })
        } catch (error) {
          update({ loading: false, error: true })
          throw error
        }
      })()
      return request.promise
    },
    [manager, scope]
  )

  const refreshPersonal = useCallback(
    (signal?: AbortSignal) =>
      read('personal', '', signal => readExperts(client, language, true, signal), true, signal),
    [client, language, read]
  )

  useEffect(() => {
    void read('personal', '', signal => readExperts(client, language, true, signal)).catch(
      () => undefined
    )
    void read('library', '', signal => readExperts(client, language, false, signal)).catch(
      () => undefined
    )
  }, [client, language, read])

  const marketActive = tab === 'market'
  useEffect(() => {
    if (!marketActive) return
    const previous = manager.requests.get('market')
    if (previous?.key === marketKey && !previous.signal.aborted) return
    // Debounce changed market filters only. Tab switches retain their in-flight read.
    if (previous?.key !== marketKey) previous?.controller.abort()
    const start = () =>
      void read('market', marketKey, signal =>
        readMarket(client, language, query, scene, signal)
      ).catch(() => undefined)
    if (!previous) {
      start()
      return
    }
    const timer = window.setTimeout(start, 250)
    return () => window.clearTimeout(timer)
  }, [client, language, manager, marketActive, marketKey, query, read, scene])

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      resource === 'personal'
        ? refreshPersonal(signal)
        : resource === 'library'
          ? read(
              'library',
              '',
              signal => readExperts(client, language, false, signal),
              true,
              signal
            )
          : read(
              'market',
              marketKey,
              signal => readMarket(client, language, query, scene, signal),
              true,
              signal
            ),
    [client, language, marketKey, query, read, refreshPersonal, resource, scene]
  )

  const active = catalog[resource]
  const marketFilterChanged = resource === 'market' && active.key !== marketKey
  const error = active.error && !marketFilterChanged
  return {
    items: catalog.personal.data,
    library: catalog.library.data,
    market: catalog.market.data.items,
    scenes: catalog.market.data.scenes,
    initialLoading: !active.loaded && !error,
    refreshing: active.loading || marketFilterChanged,
    error,
    refresh,
    refreshPersonal,
  }
}

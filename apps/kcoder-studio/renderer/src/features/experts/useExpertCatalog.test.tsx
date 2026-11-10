import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpertClient, newExpert } from './client'
import { useExpertCatalog, type ExpertTab } from './useExpertCatalog'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const item = (title: string, builtin = false) => ({
  definition: { ...newExpert('en'), id: (builtin ? 'builtin.' : 'personal.') + title, title },
  builtin,
})
const list = (items = [item('original')], nextCursor: string | null = null) => ({
  items,
  total: items.length,
  nextCursor,
})
const marketList = (title = 'market') => ({
  items: [{ slug: title, title, description: title, scene: 'tech', skillSlugs: [] }],
  scenes: ['tech'],
  nextCursor: null,
  total: 1,
})
function fixture() {
  const call = vi.fn<
    (
      method: string,
      params: { personalOnly?: boolean; cursor?: string },
      revision?: unknown,
      signal?: AbortSignal
    ) => Promise<ReturnType<typeof list>>
  >(async (_method, params) =>
    list([item(params.personalOnly ? 'original' : 'library', !params.personalOnly)])
  )
  const market = vi.fn(async () => marketList())
  const client = { controller: { call }, market } as unknown as ExpertClient
  return { client, call, market }
}
function props(client: ExpertClient, tab: ExpertTab = 'mine', query = '') {
  return { client, tab, query, language: 'en', scene: '' }
}
function useCatalog(p: ReturnType<typeof props>) {
  return useExpertCatalog(p.client, p.language, p.tab, p.query, p.scene)
}

afterEach(() => vi.useRealTimers())

describe('expert catalog read lifecycle', () => {
  it('starts in the loading state, recognizes a loaded empty list and shares it with teams', async () => {
    const f = fixture(),
      personal = deferred<ReturnType<typeof list>>(),
      library = deferred<ReturnType<typeof list>>()
    f.call.mockImplementation((_method, p) => (p.personalOnly ? personal.promise : library.promise))
    const view = renderHook(useCatalog, { initialProps: props(f.client) })
    expect(view.result.current.initialLoading).toBe(true)
    expect(f.call).toHaveBeenCalledTimes(2)
    await act(async () => personal.resolve(list([])))
    expect(view.result.current.initialLoading).toBe(false)
    expect(view.result.current.refreshing).toBe(false)
    view.rerender(props(f.client, 'teams'))
    expect(view.result.current.initialLoading).toBe(false)
    expect(f.call).toHaveBeenCalledTimes(2)
    view.rerender(props(f.client, 'library'))
    expect(view.result.current.initialLoading).toBe(true)
    await act(async () => library.resolve(list([item('template', true)])))
    expect(view.result.current.library[0].definition.title).toBe('template')
    view.rerender(props(f.client))
    view.rerender(props(f.client, 'library'))
    expect(view.result.current.initialLoading).toBe(false)
    expect(f.call).toHaveBeenCalledTimes(2)
  })

  it('filters local catalogs without refetching and never loads the market until it is visited', async () => {
    const f = fixture(),
      view = renderHook(useCatalog, { initialProps: props(f.client) })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    for (const tab of ['mine', 'teams', 'library', 'mine'] as const)
      view.rerender(props(f.client, tab, 'search'))
    expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.market).not.toHaveBeenCalled()
  })

  it('keeps the first market read alive across tab switches and retains its completed result', async () => {
    const f = fixture(),
      pending = deferred<ReturnType<typeof marketList>>()
    f.market.mockReturnValue(pending.promise)
    const view = renderHook(useCatalog, { initialProps: props(f.client, 'market') })
    expect(f.market).toHaveBeenCalledOnce()
    view.rerender(props(f.client))
    view.rerender(props(f.client, 'market'))
    expect(f.market).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(marketList('retained')))
    view.rerender(props(f.client, 'library'))
    view.rerender(props(f.client, 'market'))
    expect(view.result.current.market[0].title).toBe('retained')
    expect(view.result.current.initialLoading).toBe(false)
    expect(f.market).toHaveBeenCalledOnce()
  })

  it('debounces only changed market queries and ignores a late superseded search', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      old = deferred<ReturnType<typeof marketList>>()
    const view = renderHook(useCatalog, { initialProps: props(f.client, 'market') })
    await act(async () => {})
    f.market.mockReturnValueOnce(old.promise)
    view.rerender(props(f.client, 'market', 'old'))
    await act(async () => vi.advanceTimersByTime(249))
    expect(f.market).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(f.market).toHaveBeenCalledTimes(2)
    view.rerender(props(f.client, 'market', 'new'))
    f.market.mockResolvedValueOnce(marketList('new'))
    await act(async () => vi.advanceTimersByTime(250))
    expect(view.result.current.market[0].title).toBe('new')
    await act(async () => old.resolve(marketList('old')))
    expect(view.result.current.market[0].title).toBe('new')
  })

  it('retains content on refresh and failure, then permits an explicit retry', async () => {
    const f = fixture(),
      view = renderHook(useCatalog, { initialProps: props(f.client) })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    const pending = deferred<ReturnType<typeof list>>()
    f.call.mockReturnValueOnce(pending.promise)
    let refresh!: Promise<void>
    act(() => {
      refresh = view.result.current.refresh()
    })
    expect(view.result.current.items[0].definition.title).toBe('original')
    expect(view.result.current.initialLoading).toBe(false)
    expect(view.result.current.refreshing).toBe(true)
    await act(async () => {
      pending.reject(new Error('offline'))
      await expect(refresh).rejects.toThrow('offline')
    })
    expect(view.result.current.items).toHaveLength(1)
    expect(view.result.current.error).toBe(true)
    expect(view.result.current.refreshing).toBe(false)
    await act(async () => view.result.current.refresh())
    expect(view.result.current.error).toBe(false)
  })

  it('keeps initial failure separate from loaded empty data and retries only on request', async () => {
    const f = fixture()
    f.call.mockRejectedValueOnce(new Error('offline'))
    const view = renderHook(useCatalog, { initialProps: props(f.client) })
    await waitFor(() => expect(view.result.current.error).toBe(true))
    expect(view.result.current.initialLoading).toBe(false)
    view.rerender(props(f.client, 'teams'))
    expect(f.call).toHaveBeenCalledTimes(2)
    expect(view.result.current.error).toBe(true)
    await act(async () => view.result.current.refresh())
    expect(view.result.current.error).toBe(false)
    expect(view.result.current.items).toHaveLength(1)
  })

  it('refreshes the shared personal list after a mutation even while viewing the library', async () => {
    const f = fixture(),
      view = renderHook(useCatalog, { initialProps: props(f.client, 'library') })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    f.call.mockResolvedValueOnce(list([item('new expert')]))
    await act(async () => view.result.current.refreshPersonal())
    view.rerender(props(f.client))
    expect(view.result.current.items[0].definition.title).toBe('new expert')
    expect(f.call).toHaveBeenCalledTimes(3)
    expect(f.call.mock.calls[2][1].personalOnly).toBe(true)
  })

  it('hides old owner data immediately and rejects late completion after a target change', async () => {
    const old = fixture(),
      next = fixture(),
      pending = deferred<ReturnType<typeof list>>(),
      oldPending = deferred<ReturnType<typeof list>>()
    const view = renderHook(useCatalog, { initialProps: props(old.client) })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    old.call.mockReturnValueOnce(oldPending.promise)
    let oldRefresh!: Promise<void>
    act(() => {
      oldRefresh = view.result.current.refresh()
    })
    next.call.mockImplementation(() => pending.promise)
    view.rerender(props(next.client))
    expect(view.result.current.items).toEqual([])
    expect(view.result.current.initialLoading).toBe(true)
    await act(async () => {
      oldPending.resolve(list([item('obsolete owner')]))
      await expect(oldRefresh).rejects.toThrow()
    })
    expect(view.result.current.items).toEqual([])
    await act(async () => pending.resolve(list([item('new owner')])))
    expect(view.result.current.items[0].definition.title).toBe('new owner')
    view.unmount()
    expect(next.call.mock.calls.every(call => (call[3] as AbortSignal | undefined)?.aborted)).toBe(
      true
    )
  })

  it('publishes paginated results together rather than showing a partial list', async () => {
    const f = fixture(),
      second = deferred<ReturnType<typeof list>>()
    f.call.mockImplementation(async (_method, params) => {
      if (!params.personalOnly) return list([])
      return params.cursor ? second.promise : list([item('first')], 'next')
    })
    const view = renderHook(useCatalog, { initialProps: props(f.client) })
    await waitFor(() => expect(f.call).toHaveBeenCalledTimes(3))
    expect(view.result.current.initialLoading).toBe(true)
    expect(view.result.current.items).toEqual([])
    await act(async () => second.resolve(list([item('second')])))
    expect(view.result.current.items.map(item => item.definition.title)).toEqual([
      'first',
      'second',
    ])
  })

  it('resets translated catalogs on language changes without reusing old snapshots', async () => {
    const f = fixture(),
      pending = deferred<ReturnType<typeof list>>()
    const view = renderHook(useCatalog, { initialProps: props(f.client) })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    f.call.mockImplementation(() => pending.promise)
    view.rerender({ ...props(f.client), language: 'zh-CN' })
    expect(view.result.current.items).toEqual([])
    expect(view.result.current.initialLoading).toBe(true)
    await act(async () => pending.resolve(list([item('translated')])))
    expect(view.result.current.items[0].definition.title).toBe('translated')
  })

  it('releases superseded reads during StrictMode effect replay and still finishes loading', async () => {
    const f = fixture()
    const view = renderHook(useCatalog, { initialProps: props(f.client), reactStrictMode: true })
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false))
    expect(view.result.current.items[0].definition.title).toBe('original')
    expect(f.call.mock.calls.slice(0, 2).every(call => call[3]?.aborted)).toBe(true)
  })
})

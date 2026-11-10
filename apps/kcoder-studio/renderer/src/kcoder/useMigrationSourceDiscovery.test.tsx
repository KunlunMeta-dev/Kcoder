import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMigrationSourceDiscovery } from './useMigrationSourceDiscovery'

const response = (value: unknown) => new Response(JSON.stringify(value))
const ready = { status: 'ready', launching: false, ownedChildren: 1 }
afterEach(() => vi.unstubAllGlobals())
it('discovers only from the explicitly selected source and closes exactly its session', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    return response({ sources: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useMigrationSourceDiscovery('source-host', '/source-project', () => true))
  await act(() => result.current.discover('codex', true))
  const opened = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  expect(opened).toMatchObject({ purpose: 'source', targetId: 'source-host', workspacePath: '/source-project' })
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ session: opened,
    query: { kind: 'configuration', params: { sources: ['codex'], includeProject: true } } })
  await act(() => result.current.close())
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual(opened)
  unmount()
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('does not query after unmount while open is pending and reconciles late cleanup', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith('/open')) return new Promise(resolve => { finish = resolve })
    return response({ status: 'released' })
  })
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useMigrationSourceDiscovery('source-host', undefined, () => true))
  let pending!: Promise<void>
  act(() => { pending = result.current.discover('codex', false) })
  unmount()
  await act(async () => { finish(response(ready)); await pending })
  expect(fetcher.mock.calls.map(call => String(call[0]))).not.toContain('/api/migration/source-session/query')
  const opened = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  for (const call of fetcher.mock.calls.slice(1)) expect(JSON.parse(String(call[1]?.body))).toEqual(opened)
})
it('retains uncertain cleanup and refuses to create another source process', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'unknown' })
    return response({ sources: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useMigrationSourceDiscovery('source-host', undefined, () => true))
  await act(() => result.current.discover('codex', false))
  await act(() => result.current.discover('claude-code', false))
  expect(result.current.releasePending).toBe(true)
  expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/open'))).toHaveLength(1)
})

const codexUser = { sourceId: 'opaque-user', kind: 'codex' as const, displayName: 'Codex user', scope: 'user', formatRevision: '1', availableCategories: ['provider' as const] }
const codexNamed = { ...codexUser, sourceId: 'opaque-profile', displayName: 'Codex named profile' }
const composite = { ...codexUser, sourceId: 'native-derived', scope: 'codex-project-layers', formatRevision: 'codex-selected-layers/v1' }
function layersFixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const body = JSON.parse(String(init?.body))
    if (body.query.kind === 'configuration') return response({ sources: [codexUser, codexNamed] })
    if (body.query.kind === 'codex_layers_select') return response({ source: composite, replacesSourceIds: [codexUser.sourceId, codexNamed.sourceId] })
    if (body.query.kind === 'source_bindings') return response({ bindings: body.query.params.sourceIds.map((sourceId: string) => ({ sourceId, family: 'configuration' })) })
    const pageIndex = body.query.params.pageIndex
    return response({ target: { kind: 'source', sourceId: composite.sourceId }, status: 'available', pageIndex,
      adapterRevision: 'codex-selected-layers/v1', layers: [{ index: 0, kind: 'user', present: true }, { index: 1, kind: 'project', present: true }],
      fields: Array.from({ length: pageIndex ? 3 : 10 }, () => ({ field: null, layer: 1, providerIndex: null, supported: false, ignored: false, private: false })),
      totalFields: 13, nextPage: pageIndex ? null : 1, unobserved: ['command_line_overrides', 'source_process_environment', 'system_cloud_managed_defaults', 'managed_requirements', 'separate_mcp_namespaces', 'git_worktree_runtime_routing'] })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
it('derives only with project consent on the original source child and replaces every old model source', async () => {
  const fetcher = layersFixture()
  const { result } = renderHook(() => useMigrationSourceDiscovery('source-host', '/source-project', () => true))
  await act(() => result.current.discover('codex', false))
  await expect(result.current.deriveCodexLayers(codexNamed.sourceId)).rejects.toThrow('source_transfer_invalid_request')
  await act(() => result.current.discover('codex', true))
  await act(() => result.current.deriveCodexLayers(codexNamed.sourceId))
  expect(result.current.result?.sources).toEqual([composite])
  const frames = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  const selected = frames.find(frame => frame.query?.kind === 'codex_layers_select')
  expect(selected.query.params).toEqual({ sourceId: codexNamed.sourceId, includeProject: true })
  expect(selected.session).toEqual(result.current.session)
  await expect(result.current.selections([codexUser.sourceId])).rejects.toThrow('source_transfer_invalid_request')
  await act(async () => {
    expect((await result.current.readCodexLayers(composite.sourceId, 0)).fields).toHaveLength(10)
    expect((await result.current.readCodexLayers(composite.sourceId, 1)).fields).toHaveLength(3)
    expect(await result.current.selections([composite.sourceId])).toEqual([{ kind: 'configuration', sourceId: composite.sourceId }])
  })
})
it('rejects a delayed layer selection after source scope changes without replacing visible discovery', async () => {
  const fetcher = layersFixture(), current = { value: true }
  const { result } = renderHook(() => useMigrationSourceDiscovery('source-host', '/source-project', () => current.value))
  await act(() => result.current.discover('codex', true))
  let finish!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let pending!: Promise<unknown>
  act(() => { pending = result.current.deriveCodexLayers(codexNamed.sourceId).catch(error => error) })
  current.value = false
  await act(async () => { finish(response({ source: composite, replacesSourceIds: [codexUser.sourceId, codexNamed.sourceId] })); await pending })
  expect(result.current.result?.sources).toEqual([codexUser, codexNamed])
})
it('does not send old source cleanup through a replacement Relay mount', async () => {
  const fetcher = layersFixture()
  const { result, unmount } = renderHook(() => useMigrationSourceDiscovery('source-host', '/source-project', () => true))
  await act(() => result.current.discover('codex', true))
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/replacement' }
  unmount()
  await act(async () => {})
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/close'))).toBe(false)
  delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
})

it('authorizes the explicit source directory before discovery and reconciles a lost select reply with the original identities', async () => {
  let lose = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const input = JSON.parse(String(init?.body))
    if (input.query.kind === 'directory_select') {
      if (lose) { lose = false; throw new TypeError('owned lost directory acknowledgement') }
      return response({ selectionId: input.query.params.selectionId, source: input.query.params.source, remainingMs: 600000 })
    }
    return response({ sources: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useMigrationSourceDiscovery('remote-source', undefined, () => true))
  await act(() => result.current.discover('claude-code', false, '/source/custom-claude'))
  const before = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  expect(before.map(value => value.query?.kind ?? 'open')).toEqual(['open', 'directory_select'])
  expect(result.current.error).toBeTruthy()
  await act(() => result.current.discover('claude-code', false, '/source/custom-claude'))
  const frames = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  const selections = frames.filter(value => value.query?.kind === 'directory_select')
  expect(selections).toHaveLength(2)
  expect(selections[1]).toEqual(selections[0])
  expect(frames.filter(value => value.sessionId).every(value => value.sessionId === before[0].sessionId)).toBe(true)
  expect(frames.at(-1).query.kind).toBe('configuration')
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/close'))).toBe(false)
})
it('an unsupported directory grant never discovers home, and changing the explicit choice closes the old child first', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const input = JSON.parse(String(init?.body))
    if (input.query.kind === 'directory_select') return new Response(JSON.stringify({ error: 'source_transfer_directory_update_required' }), { status: 409 })
    throw new Error('directory selection must not fall through into default discovery')
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useMigrationSourceDiscovery('remote-source', undefined, () => true))
  await act(() => result.current.discover('codex', false, '/source/one'))
  await act(() => result.current.discover('codex', false, '/source/two'))
  const frames = fetcher.mock.calls.map(call => ({ url: String(call[0]), body: JSON.parse(String(call[1]?.body)) }))
  expect(frames.map(value => value.url.split('/').at(-1))).toEqual(['open', 'query', 'close', 'open', 'query'])
  expect(frames[0].body.sessionId).not.toEqual(frames[3].body.sessionId)
  expect(frames[1].body.query.params.selectionId).not.toEqual(frames[4].body.query.params.selectionId)
  expect(result.current.error).toBe('source_transfer_directory_update_required')
})

it('rechecks source visibility after a successful directory grant before starting discovery', async () => {
  let granted = false, current = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const body = JSON.parse(String(init?.body))
    if (body.query.kind === 'directory_select') granted = true
    return response(body.query.kind === 'directory_select'
      ? { selectionId: body.query.params.selectionId, source: body.query.params.source, remainingMs: 600000 } : { sources: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const valid = () => { if (granted) { granted = false; queueMicrotask(() => { current = false }) } return current }
  const { result } = renderHook(() => useMigrationSourceDiscovery('source', undefined, valid))
  await act(() => result.current.discover('codex', false, '/source/product'))
  expect(fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).query?.kind === 'configuration')).toHaveLength(0)
})


it('reads Claude reports only for the selected source on its original child and rejects late authority changes', async () => {
  let valid = true, expire = false;
  const source = { sourceId: 'claude-source', kind: 'claude-code', displayName: 'Claude', scope: 'user', formatRevision: 'claude-settings/v1', availableCategories: ['provider'] };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready);
    if (String(url).endsWith('/close')) return response({ status: 'released' });
    const body = JSON.parse(String(init?.body));
    if (body.query.kind === 'configuration') return response({ sources: [source] });
    if (expire) valid = false;
    return response({ target: { kind: 'source', sourceId: source.sourceId }, status: 'not_applicable', pageIndex: 0,
      adapterRevision: null, layers: [], fields: [], totalFields: 0, nextPage: null, unobserved: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  const isCurrent = () => valid;
  const { result, unmount } = renderHook(() => useMigrationSourceDiscovery('source-host', undefined, isCurrent));
  await act(() => result.current.discover('claude-code', false));
  await expect(result.current.readConfigurationLayers('peer', 0)).rejects.toThrow('source_transfer_invalid_request');
  const session = result.current.session;
  await act(() => result.current.readConfigurationLayers(source.sourceId, 0));
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ session, query: { kind: 'configuration_layers_read', params: { sourceId: source.sourceId, pageIndex: 0 } } });
  expire = true;
  await expect(result.current.readConfigurationLayers(source.sourceId, 0)).rejects.toThrow('source_transfer_authority_changed');
  unmount();
});

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useMigrationBatch } from './useMigrationBatch'

const { api } = vi.hoisted(() => ({
  api: {
    discover: vi.fn(),
    codexLayersSelect: vi.fn(),
    historyDiscover: vi.fn(),
    historySources: vi.fn(),
    scanBatch: vi.fn(),
    read: vi.fn(),
    readBatch: vi.fn(),
    runBatch: vi.fn(),
    items: vi.fn(),
    planBatch: vi.fn(),
    applyBatch: vi.fn(),
    rollbackBatch: vi.fn(),
    cancel: vi.fn(),
    batchControlRead: vi.fn(),
    batchControlCancel: vi.fn(),
    listJobs: vi.fn(),
    readBatchItem: vi.fn(),
    readBatchMcpCredentials: vi.fn(),
    previewAsset: vi.fn(),
  },
}))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const base = {
  job: {
    jobId: 'job',
    sourceId: 'source',
    status: 'ready',
    sequence: 1,
    totalItems: 22,
    committedItems: 0,
    requiresActionItems: 0,
  },
  source: 'claude-code',
  plans: [],
  issues: [],
  batch: {
    planId: null,
    selectedItems: 0,
    totalActions: 0,
    committedActions: 0,
    unresolvedActions: 0,
    defaultItemIds: ['one', 'two'],
  },
}
const planned = {
  ...base,
  job: { ...base.job, sequence: 2 },
  batch: { ...base.batch, planId: 'batch-plan', selectedItems: 2, totalActions: 2 },
}
const committed = {
  ...planned,
  job: { ...planned.job, status: 'completed', sequence: 8, committedItems: 2 },
  batch: { ...planned.batch, committedActions: 2 },
}
const first = {
  id: 'one',
  category: 'skill',
  sourceName: 'one',
  status: 'discovered',
  selectedByDefault: true,
  issues: [],
}
beforeEach(() => {
  vi.resetAllMocks()
  api.readBatch.mockRejectedValue(new Error('migration_batch_workers_update_required'))
  api.batchControlRead.mockRejectedValue(new Error('migration_batch_control_update_required'))
  api.readBatchMcpCredentials.mockResolvedValue({ job: base.job, plans: [] })
  api.scanBatch.mockResolvedValue(base)
  api.items.mockResolvedValue({
    items: [first],
    drafts: [
      {
        itemId: 'one',
        targetName: 'imported-one',
        choice: {
          kind: 'asset',
          itemId: 'one',
          targetName: 'imported-one',
          enableAfterImport: false,
        },
      },
    ],
  })
  api.planBatch.mockResolvedValue(planned)
})
afterEach(() => vi.useRealTimers())

test.each(['private_credentials_preparation_pending', 'private_credentials_publication_unknown'])('cancel preserves the exact preparation barrier %s without replay or a new sequence', async code => {
  api.readBatch.mockResolvedValue({ state: planned, workerRunning: false, workerError: null, progress: null })
  api.cancel.mockRejectedValue(new Error(code))
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.openRecord('job')); await act(() => result.current.cancel())
  expect(result.current.error).toBe(code); expect(result.current.job?.job.sequence).toBe(planned.job.sequence)
  expect(api.cancel).toHaveBeenCalledOnce(); expect(api.runBatch).not.toHaveBeenCalled()
})

test('background work starts once and is observed until the durable result settles', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  api.readBatch.mockResolvedValue({
    state: planned,
    workerRunning: false,
    workerError: null,
    progress: null,
  })
  api.runBatch.mockResolvedValue({
    state: active,
    workerRunning: true,
    workerError: null,
    progress: { actionId: 'owned', actionIndex: 0, totalActions: 2, history: null },
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  expect(api.runBatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mode: 'apply', planId: 'batch-plan' })
  )
  expect(api.applyBatch).not.toHaveBeenCalled()
  expect(result.current.workerRunning).toBe(true)
  expect(result.current.phase).toBe('progress')
  api.readBatch.mockResolvedValue({
    state: committed,
    workerRunning: false,
    workerError: null,
    progress: null,
  })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.workerRunning).toBe(false)
  expect(result.current.phase).toBe('result')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
})

test('opening stopped work only observes it; explicit recovery uses resume rather than an automatic apply', async () => {
  const interrupted = { ...planned, job: { ...planned.job, status: 'applying', sequence: 6 } }
  api.readBatch.mockResolvedValue({
    state: interrupted,
    workerRunning: false,
    workerError: 'migration_batch_worker_stopped',
    progress: null,
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.openRecord('job'))
  expect(result.current.phase).toBe('result')
  expect(api.runBatch).not.toHaveBeenCalled()
  api.runBatch.mockResolvedValue({
    state: committed,
    workerRunning: false,
    workerError: null,
    progress: null,
  })
  await act(() => result.current.operate())
  expect(api.runBatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mode: 'resume', expectedSequence: 6 })
  )
  expect(api.applyBatch).not.toHaveBeenCalled()
})

test('a peer worker is observed without submitting a second execution request', async () => {
  api.readBatch.mockResolvedValue({
    state: planned,
    workerRunning: true,
    workerError: null,
    progress: null,
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  expect(result.current.workerRunning).toBe(true)
  expect(api.runBatch).not.toHaveBeenCalled()
  expect(api.applyBatch).not.toHaveBeenCalled()
})

test('configuration and explicit historical handles enter one plan, while reset clears hidden source choices', async () => {
  api.discover.mockResolvedValue({
    sources: [
      {
        sourceId: 'config-source',
        kind: 'claude-code',
        scope: 'user',
        displayName: 'Config',
        formatRevision: 'fixture',
        availableCategories: ['mcp'],
      },
    ],
    problems: [],
  })
  api.historyDiscover.mockResolvedValue({
    catalogId: 'history-catalog',
    discoveryComplete: true,
    nextCursor: null,
    totalItems: 1,
    problems: [],
    items: [
      {
        sourceHandle: 'historical-source',
        source: 'claude-code',
        sourceSessionId: 'session',
        archived: false,
        compressed: false,
        bytes: 100,
        previewIncomplete: false,
        importIssues: [],
      },
    ],
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.discover())
  await act(() => result.current.historySources.discover())
  act(() => result.current.historySources.toggle('historical-source', true))
  await act(() => result.current.scan())
  expect(api.scanBatch).toHaveBeenCalledExactlyOnceWith({
    sourceIds: ['config-source'],
    historySources: [{ catalogId: 'history-catalog', sourceHandle: 'historical-source' }],
  })
  act(() => result.current.reset())
  expect(result.current.sources.size).toBe(0)
  expect(result.current.historySources.selections).toEqual([])
})

test('a newer cancellation requires a fresh explicitly confirmed resume identity', async () => {
  const interrupted = { ...planned, job: { ...planned.job, status: 'cancelled', sequence: 6 } }
  const newer = { ...interrupted, job: { ...interrupted.job, sequence: 7 } }
  const view = (state: typeof interrupted) => ({
    state,
    workerRunning: false,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(interrupted))
  api.runBatch.mockResolvedValueOnce(view(newer)).mockResolvedValueOnce({
    state: committed,
    workerRunning: false,
    workerError: null,
    progress: null,
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.openRecord('job'))
  await act(() => result.current.operate())
  api.readBatch.mockResolvedValue(view(newer))
  expect(api.runBatch).toHaveBeenCalledTimes(1)
  await act(() => result.current.operate())
  expect(api.runBatch).toHaveBeenCalledTimes(2)
  expect(api.runBatch.mock.calls[0][0].mode).toBe('resume')
  expect(api.runBatch.mock.calls[1][0].expectedSequence).toBe(7)
  expect(api.runBatch.mock.calls[0][0].requestId).not.toBe(api.runBatch.mock.calls[1][0].requestId)
})

test('MCP fields require explicit consent, survive pagination, and are cleared on deselection', async () => {
  api.items.mockImplementation(async ({ pageIndex }) =>
    pageIndex === 0
      ? {
          items: [{ ...first, category: 'mcp' }],
          mcps: [
            {
              itemId: 'one',
              name: 'docs',
              requiredEnv: ['TOKEN', 'OTHER'],
              requiredHeaders: ['Authorization'],
            },
          ],
          drafts: [
            {
              itemId: 'one',
              targetName: 'Docs',
              choice: { kind: 'mcp', itemId: 'one', targetName: 'Docs' },
            },
          ],
        }
      : { items: [] }
  )
  api.read.mockResolvedValue(base)
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  expect(result.current.mcpCredentials).toEqual({})
  act(() => result.current.chooseMcpFields('one', [{ kind: 'environment', name: 'TOKEN' }]))
  expect(result.current.mcpConsentPending).toBe(true)
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planBatch).not.toHaveBeenCalled()
  expect(result.current.error).toBe('migration_mcp_private_consent_required')
  act(() => result.current.consentMcpFields('one', true))
  await act(async () => {
    await result.current.paginate(1)
  })
  api.readBatchMcpCredentials.mockResolvedValue({ job: planned.job, plans: [] })
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planBatch.mock.calls[0][0].mcpCredentials).toEqual([
    { itemId: 'one', fields: [{ kind: 'environment', name: 'TOKEN' }], consentPrivateValues: true },
  ])
  act(() => result.current.choose('one', false))
  expect(result.current.mcpCredentials).toEqual({})
})

test('changing MCP fields or target options invalidates consent instead of carrying it to another binding', async () => {
  api.items.mockResolvedValue({
    items: [{ ...first, category: 'mcp' }],
    mcps: [
      {
        itemId: 'one',
        requiredEnv: ['TOKEN'],
        requiredHeaders: ['Authorization', 'authorization'],
      },
    ],
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  act(() => result.current.chooseMcpFields('one', [{ kind: 'environment', name: 'TOKEN' }]))
  act(() => result.current.consentMcpFields('one', true))
  act(() => result.current.chooseMcpFields('one', [{ kind: 'header', name: 'AUTHORIZATION' }]))
  expect(result.current.mcpCredentials.one.fields).toHaveLength(1)
  expect(result.current.mcpConsentPending).toBe(true)
  act(() => result.current.consentMcpFields('one', true))
  act(() =>
    result.current.configure({
      kind: 'mcp',
      itemId: 'one',
      targetName: 'Another',
      enableAfterImport: false,
    })
  )
  expect(result.current.mcpConsentPending).toBe(true)
  expect(result.current.mcpCredentials.one.consentPrivateValues).toBe(false)
  act(() => result.current.reset())
  expect(result.current.mcpCredentials).toEqual({})
  expect(api.planBatch).not.toHaveBeenCalled()
})

test('credential consent survives pagination but is removed when its connection is unselected', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  act(() => {
    result.current.configure({
      kind: 'provider',
      itemId: 'one',
      targetName: 'Imported',
      contextWindowTokens: 64000,
      outputHeadroomTokens: 8192,
      maxOutputTokens: 8192,
    })
    result.current.chooseCredential('one', 'configuration')
  })
  await act(async () => {
    await result.current.paginate(1)
  })
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planBatch.mock.calls[0][0].credentials).toEqual([
    { itemId: 'one', source: 'configuration', consentApiKey: true },
  ])
  act(() => result.current.choose('one', false))
  expect(result.current.credentials).toEqual({})
})

test('a single confirmation includes defaults beyond the visible page and preserves explicit exclusions', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  api.discover.mockResolvedValue({
    sources: [{ sourceId: 'skills' }, { sourceId: 'instructions' }],
  })
  await act(async () => {
    await result.current.discover()
  })
  await act(async () => {
    await result.current.scan()
  })
  expect(api.scanBatch).toHaveBeenCalledWith({ sourceIds: ['skills', 'instructions'] })
  expect([...result.current.selected]).toEqual(['one', 'two'])
  act(() => result.current.choose('one', false))
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planBatch).toHaveBeenCalledWith({
    jobId: 'job',
    expectedSequence: 1,
    choices: [],
    includeDefaultItems: true,
    reuseExisting: true,
    excludedItemIds: ['one'],
  })
  expect(result.current.phase).toBe('review')
})

test('lost apply replies are observed before an explicit retry with the same plan and request identity', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  await act(async () => {
    await result.current.plan()
  })
  api.applyBatch
    .mockRejectedValueOnce(new Error('transport interrupted'))
    .mockResolvedValueOnce(committed)
  api.read.mockResolvedValueOnce({
    ...planned,
    job: { ...planned.job, status: 'applying', sequence: 4 },
  })
  await act(async () => {
    await result.current.operate()
  })
  expect(api.read).toHaveBeenCalledWith('job')
  expect(result.current.job?.job.sequence).toBe(4)
  const identity = api.applyBatch.mock.calls[0][0].requestId
  await act(async () => {
    await result.current.operate()
  })
  expect(api.applyBatch.mock.calls[1][0]).toEqual({
    jobId: 'job',
    planId: 'batch-plan',
    requestId: identity,
    expectedSequence: 4,
  })
  expect(result.current.phase).toBe('result')
})

test('records reopen durable plans without scanning or implicitly applying and keep rollback retries separate', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  api.read.mockResolvedValueOnce(committed)
  await act(async () => {
    await result.current.openRecord('job')
  })
  expect(api.scanBatch).not.toHaveBeenCalled()
  expect(api.applyBatch).not.toHaveBeenCalled()
  api.rollbackBatch.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({
    ...committed,
    job: { ...committed.job, status: 'rolled_back', sequence: 12, committedItems: 0 },
  })
  api.read.mockResolvedValueOnce({
    ...committed,
    job: { ...committed.job, status: 'rolling_back', sequence: 9 },
  })
  await act(async () => {
    await result.current.operate(true)
  })
  const identity = api.rollbackBatch.mock.calls[0][0].requestId
  expect(result.current.lastAction).toBe('rollback')
  await act(async () => {
    await result.current.operate(true)
  })
  expect(api.rollbackBatch.mock.calls[1][0].requestId).toBe(identity)
  expect(api.applyBatch).not.toHaveBeenCalled()
})

test('an account change discards a delayed scan and its item reads', async () => {
  let current = true,
    resolve!: (value: unknown) => void
  api.scanBatch.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => current))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.scan()
  })
  current = false
  await act(async () => {
    resolve(base)
    await pending
  })
  expect(result.current.job).toBeNull()
  expect(api.items).not.toHaveBeenCalled()
})

test('batch pages retain their index and use native immutable-inventory paging', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  await act(async () => {
    await result.current.paginate(1)
  })
  expect(result.current.pageIndex).toBe(1)
  expect(api.items).toHaveBeenLastCalledWith({ jobId: 'job', pageIndex: 1, includeTemplates: true })
  api.read.mockResolvedValueOnce({ ...base, job: { ...base.job, sequence: 3 } })
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.pageIndex).toBe(1)
  expect(api.items).toHaveBeenLastCalledWith({ jobId: 'job', pageIndex: 1, includeTemplates: true })
})

test('late private-step updates cannot roll the current batch sequence back', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(async () => {
    await result.current.scan()
  })
  act(() =>
    result.current.acceptUpdatedJob({ ...base, job: { ...base.job, sequence: 12 } } as never)
  )
  act(() =>
    result.current.acceptUpdatedJob({ ...base, job: { ...base.job, sequence: 5 } } as never)
  )
  expect(result.current.job?.job.sequence).toBe(12)
})

test('a terminal worker snapshot still publishes its delayed final item page', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committing' }] })
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.items.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  api.readBatch.mockResolvedValue({
    ...view(committed, false),
    progress: { actionId: 'last', actionIndex: 1, totalActions: 2, history: null },
  })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.job?.job.sequence).toBe(8)
  expect(result.current.settling).toBe(true)
  expect(result.current.busy).toBe(true)
  expect(result.current.workerRunning).toBe(false)
  expect(result.current.workerProgress).toBeNull()
  expect(result.current.page.items[0].status).toBe('committing')
  await act(async () => {
    resolve({ items: [{ ...first, status: 'committed' }] })
  })
  expect(result.current.job?.job.sequence).toBe(8)
  expect(result.current.phase).toBe('result')
  expect(result.current.settling).toBe(false)
  expect(result.current.workerProgress).toBeNull()
  expect(result.current.page.items[0].status).toBe('committed')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
  expect(api.applyBatch).not.toHaveBeenCalled()
})

test('a delayed terminal page cannot replace a reset and reopened selection of the same job', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.items.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  api.readBatch.mockResolvedValue(view(committed, false))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  act(() => result.current.reset())
  const reopened = { ...committed, job: { ...committed.job, sequence: 12 } }
  api.readBatch.mockResolvedValue(view(reopened, false))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'reopened', status: 'committed' }],
  })
  await act(() => result.current.openRecord('job'))
  await act(async () => {
    resolve({ items: [{ ...first, sourceName: 'stale terminal page', status: 'committed' }] })
  })
  expect(result.current.job?.job.sequence).toBe(12)
  expect(result.current.page.items[0].sourceName).toBe('reopened')
})

test('a delayed terminal page cannot cross an invalidated target scope with the same job id', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  let oldCurrent = true
  const oldScope = () => oldCurrent
  const { result, rerender } = renderHook(
    ({ target, isCurrent }) => useMigrationBatch(target, '/workspace', isCurrent),
    { initialProps: { target: 'target', isCurrent: oldScope } }
  )
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.items.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  api.readBatch.mockResolvedValue(view(committed, false))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  oldCurrent = false
  rerender({ target: 'other-target', isCurrent: () => true })
  act(() => result.current.reset())
  api.readBatch.mockResolvedValue(view(committed, false))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'other target', status: 'committed' }],
  })
  await act(() => result.current.openRecord('job'))
  await act(async () => {
    resolve({ items: [{ ...first, sourceName: 'old target', status: 'committed' }] })
  })
  expect(result.current.page.items[0].sourceName).toBe('other target')
})

test('a late terminal snapshot cannot stop a reset and reopened worker of the same job', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.readBatch.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  await act(() => vi.advanceTimersByTimeAsync(1000))
  act(() => result.current.reset())
  const reopened = { ...active, job: { ...active.job, sequence: 12 } }
  api.readBatch.mockResolvedValue(view(reopened, true))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'new worker', status: 'committing' }],
  })
  await act(() => result.current.openRecord('job'))
  await act(async () => {
    resolve(view(committed, false))
  })
  expect(result.current.job?.job.sequence).toBe(12)
  expect(result.current.workerRunning).toBe(true)
  expect(result.current.page.items[0].sourceName).toBe('new worker')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
})

test('a failed terminal page read retries observation without claiming completion or replaying work', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committing' }] })
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  api.readBatch.mockResolvedValue(view(committed, false))
  api.items.mockRejectedValueOnce(new Error('lost page reply'))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.phase).toBe('progress')
  expect(result.current.page.items[0].status).toBe('committing')
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committed' }] })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.phase).toBe('result')
  expect(result.current.page.items[0].status).toBe('committed')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
  expect(api.applyBatch).not.toHaveBeenCalled()
})

test('a terminal worker refreshes items even if another receipt already advanced the job sequence', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committing' }] })
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  act(() => result.current.acceptUpdatedJob(committed as never))
  api.readBatch.mockResolvedValue(view(committed, false))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committed' }] })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.phase).toBe('result')
  expect(result.current.page.items[0].status).toBe('committed')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
})

test('an older terminal page cannot overwrite a newer receipt or stop its current observation', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committing' }] })
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.items.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  api.readBatch.mockResolvedValue(view(committed, false))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  const newer = { ...active, job: { ...active.job, sequence: 12 } }
  act(() => result.current.acceptUpdatedJob(newer as never))
  await act(async () => {
    resolve({ items: [{ ...first, sourceName: 'stale terminal', status: 'committed' }] })
  })
  expect(result.current.job?.job.sequence).toBe(12)
  expect(result.current.page.items[0].status).toBe('committing')
  expect(result.current.workerRunning).toBe(false)
  expect(result.current.settling).toBe(true)
  const latest = { ...committed, job: { ...committed.job, sequence: 13 } }
  api.readBatch.mockResolvedValue(view(latest, false))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'latest terminal', status: 'committed' }],
  })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.job?.job.sequence).toBe(13)
  expect(result.current.page.items[0].sourceName).toBe('latest terminal')
  expect(result.current.phase).toBe('result')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
})

test('cancel observing an already terminal worker reconciles the final page without cancelling again', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  api.items.mockResolvedValue({ items: [{ ...first, status: 'committing' }] })
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  let resolve!: (value: unknown) => void
  api.items.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  api.readBatch.mockResolvedValue(view(committed, false))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'cancel reconciliation', status: 'committed' }],
  })
  await act(() => result.current.cancel())
  expect(result.current.page.items[0].status).toBe('committed')
  expect(api.cancel).not.toHaveBeenCalled()
  await act(async () => {
    resolve({ items: [{ ...first, sourceName: 'late poll', status: 'committed' }] })
  })
  expect(result.current.page.items[0].sourceName).toBe('cancel reconciliation')
  expect(result.current.workerRunning).toBe(false)
  expect(result.current.phase).toBe('result')
  expect(api.runBatch).toHaveBeenCalledTimes(1)
})

test('a late cancellation receipt cannot replace a different reopened job', async () => {
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 3 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({
    state,
    workerRunning,
    workerError: null,
    progress: null,
  })
  api.readBatch.mockResolvedValue(view(planned, false))
  api.runBatch.mockResolvedValue(view(active, true))
  const isCurrent = () => true
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', isCurrent))
  await act(() => result.current.scan())
  await act(() => result.current.plan())
  await act(() => result.current.operate())
  api.readBatch.mockResolvedValue(view(active, true))
  let resolve!: (value: unknown) => void
  api.cancel.mockReturnValueOnce(
    new Promise(done => {
      resolve = done
    })
  )
  let pending!: Promise<void>
  await act(async () => {
    pending = result.current.cancel()
  })
  expect(api.cancel).toHaveBeenCalledTimes(1)
  act(() => result.current.reset())
  const other = { ...committed, job: { ...committed.job, jobId: 'other-job' } }
  api.readBatch.mockResolvedValue(view(other, false))
  api.items.mockResolvedValue({
    items: [{ ...first, sourceName: 'other job', status: 'committed' }],
  })
  await act(() => result.current.openRecord('other-job'))
  await act(async () => {
    resolve({ ...active, job: { ...active.job, status: 'cancel_requested', sequence: 5 } })
    await pending
  })
  expect(result.current.job?.job.jobId).toBe('other-job')
  expect(result.current.page.items[0].sourceName).toBe('other job')
  expect(result.current.cancelling).toBe(false)
})

test('active cancel uses the admitted generation and waits for the original worker to stop', async () => {
  vi.useFakeTimers()
  const active = { ...planned, job: { ...planned.job, status: 'applying', sequence: 14 } }
  const view = (state: typeof planned, workerRunning: boolean) => ({ state, workerRunning, workerError: null, progress: null })
  api.readBatch.mockResolvedValue(view(active, true))
  api.batchControlRead.mockResolvedValue({ jobId: 'job', currentSequence: 20, planId: 'batch-plan', phase: 'tracked',
    generation: { planId: 'batch-plan', runRequestId: 'original-run', admissionSequence: 3, mode: 'apply' },
    cancelRequested: false, lastCancellation: null, requestedReceipt: null })
  api.batchControlCancel.mockImplementation(async intent => {
    const receipt = { commandId: intent.commandId, planId: intent.planId, runRequestId: intent.runRequestId, admissionSequence: intent.admissionSequence }
    const requested = { ...active, job: { ...active.job, status: 'cancel_requested', sequence: 30 } }
    api.readBatch.mockResolvedValue(view(requested, true))
    return { jobId: 'job', currentSequence: 29, planId: 'batch-plan', phase: 'tracked',
      generation: { planId: 'batch-plan', runRequestId: 'original-run', admissionSequence: 3, mode: 'apply' },
      cancelRequested: true, lastCancellation: { ...receipt, acceptedSequence: 29 }, requestedReceipt: { ...receipt, acceptedSequence: 29 } }
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.openRecord('job'))
  await act(() => result.current.cancel())
  expect(api.batchControlCancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: 'job', planId: 'batch-plan', runRequestId: 'original-run', admissionSequence: 3 }))
  expect(api.batchControlCancel.mock.calls[0][0]).not.toHaveProperty('expectedSequence')
  expect(api.cancel).not.toHaveBeenCalled()
  expect(result.current.workerRunning).toBe(true)
  expect(result.current.job?.job.status).toBe('cancel_requested')
  api.readBatch.mockResolvedValue(view({ ...active, job: { ...active.job, status: 'cancelled', sequence: 31 } }, false))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current.workerRunning).toBe(false)
  expect(result.current.job?.job.status).toBe('cancelled')
})

test('explicit ready plugins carry only native operation identity into scan and reset with source kind', async () => {
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  act(() => result.current.selectPlugin('owned-plugin', 3, 'Office package'))
  act(() => result.current.selectPlugin('owned-plugin', 4, 'Updated package'))
  expect(result.current.plugins).toEqual([
    { operationId: 'owned-plugin', expectedSequence: 4, name: 'Updated package' },
  ])
  await act(() => result.current.scan())
  expect(api.scanBatch).toHaveBeenLastCalledWith({
    sourceIds: [],
    pluginSources: [{ operationId: 'owned-plugin', expectedSequence: 4 }],
  })
  act(() => result.current.reset())
  expect(result.current.plugins).toEqual([])
  act(() => result.current.selectPlugin('other-plugin', 1, 'Other package'))
  act(() => result.current.setKind('codex'))
  expect(result.current.plugins).toEqual([])
})

const codexSource = (sourceId: string, scope = 'user') => ({
  sourceId,
  kind: 'codex',
  scope,
  displayName: sourceId,
  formatRevision: 'fixture',
  availableCategories: ['provider'],
})
test('project layers are explicit and replace configuration selections without dropping unrelated assets', async () => {
  api.discover.mockResolvedValue({
    sources: [
      codexSource('base'),
      codexSource('profile'),
      codexSource('project', 'project'),
      codexSource('skill', 'user-skill'),
    ],
    problems: [],
  })
  api.codexLayersSelect.mockResolvedValue({
    source: codexSource('composite', 'codex-project-layers'),
    replacesSourceIds: ['base', 'profile', 'project'],
  })
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => true))
  await act(() => result.current.deriveCodexLayers('base'))
  expect(api.codexLayersSelect).not.toHaveBeenCalled()
  act(() => {
    result.current.setKind('codex')
    result.current.setIncludeProject(true)
  })
  await act(() => result.current.discover())
  expect(api.codexLayersSelect).not.toHaveBeenCalled()
  expect([...result.current.sources]).toEqual(['base', 'profile', 'project', 'skill'])
  await act(() => result.current.deriveCodexLayers('profile'))
  expect(api.codexLayersSelect).toHaveBeenCalledExactlyOnceWith({
    sourceId: 'profile',
    includeProject: true,
  })
  expect([...result.current.sources]).toEqual(['composite', 'skill'])
  await act(() => result.current.scan())
  expect(api.scanBatch).toHaveBeenCalledWith({ sourceIds: ['composite', 'skill'] })
})
test('late or retained derivation callbacks cannot reselect a previous source after vendor or account changes', async () => {
  api.discover.mockResolvedValue({ sources: [codexSource('base')], problems: [] })
  let resolve!: (value: unknown) => void,
    current = true
  api.codexLayersSelect.mockImplementation(
    () =>
      new Promise(yes => {
        resolve = yes
      })
  )
  const { result } = renderHook(() => useMigrationBatch('target', '/workspace', () => current))
  act(() => {
    result.current.setKind('codex')
    result.current.setIncludeProject(true)
  })
  await act(() => result.current.discover())
  const retained = result.current.deriveCodexLayers
  let pending!: Promise<void>
  act(() => {
    pending = retained('base')
  })
  act(() => result.current.setKind('claude-code'))
  await act(async () => {
    resolve({
      source: codexSource('composite', 'codex-project-layers'),
      replacesSourceIds: ['base'],
    })
    await pending
  })
  expect(result.current.discovery).toBeNull()
  expect(result.current.sources.size).toBe(0)
  await act(() => retained('base'))
  expect(api.codexLayersSelect).toHaveBeenCalledTimes(1)
  act(() => {
    result.current.setKind('codex')
    result.current.setIncludeProject(true)
  })
  await act(() => result.current.discover())
  act(() => {
    pending = result.current.deriveCodexLayers('base')
  })
  current = false
  await act(async () => {
    resolve({ source: codexSource('foreign', 'codex-project-layers'), replacesSourceIds: ['base'] })
    await pending
  })
  expect(result.current.sources.has('foreign')).toBe(false)
})

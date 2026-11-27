import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigration } from './useMigration'

const { api } = vi.hoisted(() => ({
  api: {
    discover: vi.fn(),
    scan: vi.fn(),
    read: vi.fn(),
    items: vi.fn(),
    plan: vi.fn(),
    apply: vi.fn(),
    rollback: vi.fn(),
    cancel: vi.fn(),
    planMcp: vi.fn(),
    applyMcp: vi.fn(),
    rollbackMcp: vi.fn(),
    planAsset: vi.fn(),
    applyAsset: vi.fn(),
    rollbackAsset: vi.fn(),
    previewAsset: vi.fn(),
  },
}))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const candidate = {
  itemId: 'provider',
  apiFormat: 'anthropic_messages',
  endpoint: 'https://example.invalid',
  model: 'fixture',
  contextWindowTokens: 128000,
  outputHeadroomTokens: null,
  maxOutputTokens: null,
}
const item = {
  id: 'provider',
  category: 'provider',
  sourceName: 'Fixture',
  status: 'requires_action',
  selectedByDefault: false,
  issues: [{ code: 'credential_resolution_required', phase: 'activation', severity: 'blocking' }],
}
const ready = {
  job: {
    jobId: 'job',
    sourceId: 'source',
    status: 'ready',
    sequence: 2,
    totalItems: 1,
    committedItems: 0,
    requiresActionItems: 1,
  },
  source: 'claude-code',
  plans: [],
  issues: [],
}
const planned = {
  ...ready,
  job: { ...ready.job, sequence: 4 },
  plans: [
    {
      planId: 'stable-plan',
      itemId: 'provider',
      targetName: 'Fixture',
      provider: candidate,
    },
  ],
}
beforeEach(() => {
  vi.resetAllMocks()
  api.scan.mockResolvedValue(ready)
  api.items.mockResolvedValue({ items: [item], providers: [candidate] })
  api.plan.mockResolvedValue(planned)
})

test.each(['private_credentials_preparation_pending', 'private_credentials_publication_unknown'])('cancel preserves only the exact preparation barrier %s', async code => {
  api.read.mockResolvedValue(ready); api.cancel.mockRejectedValue(new Error(code))
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(() => result.current.scan('source-grant')); await act(() => result.current.cancel())
  expect(result.current.error).toBe(code); expect(result.current.job?.job.sequence).toBe(ready.job.sequence)
  expect(api.cancel).toHaveBeenCalledOnce(); expect(api.apply).not.toHaveBeenCalled()
})

test('work assets are previewed and inactive by default; apply and undo keep the durable asset identity', async () => {
  const asset = { itemId: 'asset', name: 'review-api', bytes: 48, files: 1, nativeReference: false }
  const preview = {
    ...item,
    id: 'asset',
    category: 'skill',
    sourceName: 'review-api',
    issues: [],
    status: 'discovered',
  }
  api.items.mockResolvedValue({ items: [preview], providers: [], assets: [asset] })
  api.previewAsset.mockResolvedValue({
    itemId: 'asset',
    text: 'Original instructions',
    totalBytes: 21,
    nextOffset: null,
  })
  const plan = {
    ...ready,
    job: { ...ready.job, sequence: 4 },
    assetPlans: [
      {
        planId: 'asset-plan',
        itemId: 'asset',
        targetName: 'review-api',
        enableAfterImport: false,
        nativeReference: false,
        projectScoped: false,
      },
    ],
  }
  api.planAsset.mockResolvedValue(plan)
  api.applyAsset.mockResolvedValue({
    ...plan,
    job: { ...plan.job, status: 'completed', sequence: 6, committedItems: 1 },
  })
  api.rollbackAsset.mockResolvedValue({
    ...plan,
    job: { ...plan.job, status: 'rolled_back', sequence: 8, committedItems: 0 },
  })
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('source-grant')
  })
  expect(result.current.assetPreview?.text).toBe('Original instructions')
  expect(result.current.canPlan).toBe(true)
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planAsset).toHaveBeenCalledWith({
    jobId: 'job',
    expectedSequence: 2,
    itemId: 'asset',
    targetName: 'review-api',
    enableAfterImport: false,
  })
  await act(async () => {
    await result.current.apply()
  })
  expect(api.applyAsset).toHaveBeenCalledWith({
    jobId: 'job',
    expectedSequence: 4,
    planId: 'asset-plan',
  })
  await act(async () => {
    await result.current.rollback()
  })
  expect(api.rollbackAsset).toHaveBeenCalledWith({
    jobId: 'job',
    expectedSequence: 6,
    planId: 'asset-plan',
  })
  expect(api.apply).not.toHaveBeenCalled()
  expect(api.planMcp).not.toHaveBeenCalled()
})

test('missing limits require explicit input and a lost receipt is read before an explicit stable-plan retry', async () => {
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('source-grant')
  })
  expect(result.current.canPlan).toBe(false)
  act(() => result.current.setForm(old => ({ ...old, headroom: '8192', output: '8192' })))
  expect(result.current.canPlan).toBe(true)
  await act(async () => {
    await result.current.plan()
  })
  expect(api.apply).not.toHaveBeenCalled()
  expect(result.current.stage).toBe('review')
  api.apply.mockRejectedValueOnce(new Error('connection closed'))
  api.read.mockResolvedValue({
    ...planned,
    job: { ...planned.job, status: 'applying', sequence: 5 },
  })
  await act(async () => {
    await result.current.apply()
  })
  expect(api.apply).toHaveBeenCalledTimes(1)
  expect(api.read).toHaveBeenCalledWith('job')
  expect(result.current.job?.job.sequence).toBe(5)
  api.apply.mockResolvedValue({
    ...planned,
    job: { ...planned.job, status: 'completed_with_issues', sequence: 6, committedItems: 1 },
  })
  await act(async () => {
    await result.current.apply()
  })
  expect(api.apply).toHaveBeenNthCalledWith(1, {
    jobId: 'job',
    planId: 'stable-plan',
    expectedSequence: 4,
  })
  expect(api.apply).toHaveBeenNthCalledWith(2, {
    jobId: 'job',
    planId: 'stable-plan',
    expectedSequence: 5,
  })
  expect(result.current.stage).toBe('result')
})

test('expired account scope discards a late source result', async () => {
  let current = true
  let finish!: (value: object) => void
  api.discover.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const { result } = renderHook(() => useMigration('remote', '/owned', () => current))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.discover()
  })
  await waitFor(() => expect(api.discover).toHaveBeenCalled())
  current = false
  await act(async () => {
    finish({ sources: [{ sourceId: 'old-account-source' }] })
    await pending
  })
  expect(result.current.discovery).toBeNull()
  expect(api.scan).not.toHaveBeenCalled()
})

test('incompatible selected items stay blocked after browsing another page', async () => {
  api.items.mockResolvedValueOnce({
    items: [{ ...item, issues: [{ code: 'unsupported_field', severity: 'blocking' }] }],
    providers: [candidate],
    nextCursor: 'next',
  })
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('grant')
  })
  act(() => result.current.setForm(old => ({ ...old, headroom: '8192', output: '8192' })))
  api.items.mockResolvedValue({ items: [], providers: [] })
  await act(async () => {
    await result.current.paginate(1)
  })
  expect(result.current.canPlan).toBe(false)
  expect(result.current.form.model).toBe('fixture')
})

test('an unconfirmed rollback stays a rollback and retries the same plan instead of importing again', async () => {
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('grant')
  })
  act(() => result.current.setForm(old => ({ ...old, headroom: '8192', output: '8192' })))
  await act(async () => {
    await result.current.plan()
  })
  const committed = {
    ...planned,
    job: { ...planned.job, status: 'completed_with_issues', sequence: 6, committedItems: 1 },
  }
  api.apply.mockResolvedValue(committed)
  await act(async () => {
    await result.current.apply()
  })
  api.rollback.mockRejectedValueOnce(new Error('connection closed'))
  api.read.mockResolvedValue({
    ...committed,
    job: { ...committed.job, status: 'rolling_back', sequence: 7 },
  })
  await act(async () => {
    await result.current.rollback()
  })
  expect(result.current.stage).toBe('result')
  expect(result.current.uncertainAction).toBe('rollback')
  api.rollback.mockResolvedValue({
    ...committed,
    job: { ...committed.job, status: 'rolled_back', sequence: 8, committedItems: 0 },
  })
  await act(async () => {
    await result.current.rollback()
  })
  expect(api.rollback).toHaveBeenNthCalledWith(2, {
    jobId: 'job',
    planId: 'stable-plan',
    expectedSequence: 7,
  })
  expect(api.apply).toHaveBeenCalledTimes(1)
  expect(result.current.uncertainAction).toBeNull()
  expect(result.current.job?.job.status).toBe('rolled_back')
})

test('a lost submission and failed observation remain visibly unconfirmed without automatic retry', async () => {
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('grant')
  })
  act(() => result.current.setForm(old => ({ ...old, headroom: '8192', output: '8192' })))
  await act(async () => {
    await result.current.plan()
  })
  api.apply.mockRejectedValue(new Error('connection closed'))
  api.read.mockRejectedValue(new Error('still offline'))
  await act(async () => {
    await result.current.apply()
  })
  expect(result.current.uncertainAction).toBe('apply')
  expect(result.current.stage).toBe('review')
  expect(api.apply).toHaveBeenCalledTimes(1)
})

test('MCP definitions use their own stable plan, default to disabled and retry a lost receipt without becoming a Provider', async () => {
  const mcp = {
    itemId: 'mcp',
    name: 'documents',
    transport: 'stdio',
    command: 'fixture',
    url: '',
    requiredEnv: ['PRIVATE_INPUT'],
    requiredHeaders: [],
    enabledInSource: true,
  }
  api.items.mockResolvedValue({
    items: [{ ...item, id: 'mcp', category: 'mcp', sourceName: 'documents' }],
    providers: [],
    mcps: [mcp],
  })
  const mcps = {
    ...ready,
    plans: [],
    mcpPlans: [
      {
        planId: 'stable-mcp',
        itemId: 'mcp',
        config: {
          name: 'documents',
          transport: 'stdio',
          command: 'fixture',
          policy: { required_env: ['PRIVATE_INPUT'] },
        },
        enableAfterImport: false,
      },
    ],
  }
  api.planMcp.mockResolvedValue({ ...mcps, job: { ...ready.job, sequence: 4 } })
  const { result } = renderHook(() => useMigration('remote', '/owned', () => true))
  await act(async () => {
    await result.current.scan('grant')
  })
  expect(result.current.mcpCandidate?.name).toBe('documents')
  expect(result.current.candidate).toBeNull()
  expect(result.current.enableMcp).toBe(false)
  expect(result.current.canPlan).toBe(true)
  await act(async () => {
    await result.current.plan()
  })
  expect(api.planMcp).toHaveBeenCalledWith({
    jobId: 'job',
    expectedSequence: 2,
    itemId: 'mcp',
    targetName: 'documents',
    enableAfterImport: false,
  })
  api.applyMcp.mockRejectedValueOnce(new Error('offline'))
  api.read.mockResolvedValue({ ...mcps, job: { ...ready.job, status: 'applying', sequence: 5 } })
  await act(async () => {
    await result.current.apply()
  })
  expect(api.applyMcp).toHaveBeenCalledTimes(1)
  expect(api.apply).not.toHaveBeenCalled()
  api.applyMcp.mockResolvedValue({
    ...mcps,
    job: { ...ready.job, status: 'completed_with_issues', sequence: 6, committedItems: 1 },
  })
  await act(async () => {
    await result.current.apply()
  })
  expect(api.applyMcp).toHaveBeenNthCalledWith(2, {
    jobId: 'job',
    planId: 'stable-mcp',
    expectedSequence: 5,
  })
  api.rollbackMcp.mockResolvedValue({
    ...mcps,
    job: { ...ready.job, status: 'rolled_back', sequence: 8, committedItems: 0 },
  })
  await act(async () => {
    await result.current.rollback()
  })
  expect(api.rollbackMcp).toHaveBeenCalledWith({
    jobId: 'job',
    planId: 'stable-mcp',
    expectedSequence: 6,
  })
  expect(api.rollback).not.toHaveBeenCalled()
})

test('restoring a saved MCP record finds its declared fields beyond the first page', async () => {
  const saved = {
    ...ready,
    job: {
      ...ready.job,
      status: 'completed_with_issues',
      sequence: 9,
      totalItems: 12,
      committedItems: 1,
    },
    plans: [],
    mcpPlans: [
      { planId: 'saved-mcp', itemId: 'later-mcp', targetName: 'Docs', enableAfterImport: false },
    ],
  }
  api.read.mockResolvedValue(saved)
  api.items
    .mockResolvedValueOnce({ items: [], providers: [], mcps: [], nextCursor: 'second-page' })
    .mockResolvedValueOnce({
      items: [
        {
          id: 'later-mcp',
          sourceName: 'docs',
          category: 'mcp',
          status: 'committed',
          selectedByDefault: false,
          issues: [],
        },
      ],
      providers: [],
      mcps: [{ itemId: 'later-mcp', name: 'docs', requiredEnv: ['TOKEN'], requiredHeaders: [] }],
    })
  const { result } = renderHook(() => useMigration('target', '/workspace', () => true))
  await act(async () => {
    await result.current.openRecord('job')
  })
  expect(result.current.pageIndex).toBe(1)
  expect(result.current.page.mcps?.[0]?.requiredEnv).toEqual(['TOKEN'])
  expect(api.items).toHaveBeenLastCalledWith({ jobId: saved.job.jobId, cursor: 'second-page' })
})

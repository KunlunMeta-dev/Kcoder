import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationBatchWorkspace } from './MigrationBatchWorkspace'

const { api } = vi.hoisted(() => ({
  api: {
    discover: vi.fn(),
    scanBatch: vi.fn(),
    read: vi.fn(),
    readBatch: vi.fn(),
    runBatch: vi.fn(),
    items: vi.fn(),
    planBatch: vi.fn(),
    readMcpCredentials: vi.fn(),
    readBatchMcpCredentials: vi.fn(),
  },
}))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const job = {
  source: 'codex',
  plans: [],
  issues: [],
  job: {
    jobId: 'owned-job',
    sourceId: 'source',
    sequence: 1,
    status: 'ready',
    totalItems: 12,
    committedItems: 0,
    requiresActionItems: 2,
  },
  batch: {
    planId: null,
    defaultItemIds: [],
    selectedItems: 0,
    totalActions: 0,
    committedActions: 0,
    unresolvedActions: 0,
  },
}
const providerPage = {
  items: [
    {
      id: 'provider',
      sourceName: 'Office',
      category: 'provider',
      status: 'requires_action',
      selectedByDefault: false,
      issues: [],
    },
  ],
  providers: [
    {
      itemId: 'provider',
      apiFormat: 'openai_responses',
      endpoint: 'https://example.invalid/v1',
      model: 'office-model',
    },
  ],
  drafts: [{ itemId: 'provider', targetName: 'ImportedOffice', choice: null }],
}
const templatePage = {
  items: [
    {
      id: 'template',
      sourceName: 'review.config.toml',
      category: 'provider',
      status: 'requires_action',
      selectedByDefault: false,
      issues: [],
    },
  ],
  templates: [
    {
      itemId: 'template',
      name: 'review.config.toml',
      providerItemId: 'provider',
      providerName: 'Office',
      providerPageIndex: 0,
      reasoningEffort: 'high',
    },
  ],
  drafts: [{ itemId: 'template', targetName: 'imported-review', choice: null }],
}
beforeEach(() => {
  vi.resetAllMocks()
  api.readBatch.mockRejectedValue(new Error('migration_batch_workers_update_required'))
  api.readBatchMcpCredentials.mockResolvedValue({ job: job.job, plans: [] })
  api.read.mockResolvedValue(job)
  api.items.mockImplementation(async ({ pageIndex }) =>
    pageIndex === 1 ? templatePage : providerPage
  )
  api.planBatch.mockResolvedValue({
    ...job,
    job: { ...job.job, sequence: 2 },
    batch: { ...job.batch, planId: 'owned-plan', selectedItems: 2, totalActions: 2 },
  })
})
function mount() {
  render(
    <MigrationBatchWorkspace
      deviceId="target"
      workspacePath="/owned"
      initialJobId="owned-job"
      isCurrent={() => true}
      onBusy={() => {}}
      onLegacy={() => {}}
      onOpenRecord={() => {}}
    />
  )
}

test('failed discovery explains the blocked source without reporting it as a missing installation', async () => {
  api.discover.mockResolvedValue({ sources: [], problems: [{ kind: 'claude-code', scope: 'user', code: 'migration_source_directory_untrusted' }] })
  render(<MigrationBatchWorkspace deviceId="target" workspacePath="/owned" isCurrent={() => true}
    onBusy={() => {}} onLegacy={() => {}} onOpenRecord={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'find' }))
  expect(await screen.findByText('errors.migration_source_directory_untrusted', { exact: false })).toBeInTheDocument()
  expect(screen.queryByText('empty', { exact: true })).not.toBeInTheDocument()
})
async function configureProvider() {
  await screen.findByText('Office')
  fireEvent.click(screen.getByRole('button', { name: 'batch.options' }))
  fireEvent.change(screen.getByLabelText('context'), { target: { value: '128000' } })
  fireEvent.change(screen.getByLabelText('headroom'), { target: { value: '8192' } })
  fireEvent.change(screen.getByLabelText('output'), { target: { value: '8192' } })
  fireEvent.click(screen.getByRole('button', { name: 'batch.save_options' }))
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'batch.select_item' })).toBeChecked()
  )
}
async function nextTemplate() {
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await screen.findByText('review.config.toml')
  fireEvent.click(screen.getByRole('button', { name: 'batch.options' }))
}

test('memory requires an explicit target scope and is always submitted disabled through the ordinary batch', async () => {
  api.items.mockResolvedValue({ items: [{ id: 'memory', sourceName: 'MEMORY.md', category: 'memory', status: 'requires_action', selectedByDefault: false, issues: [] }],
    assets: [{ itemId: 'memory', name: 'ImportedNotes', bytes: 40, files: 1, nativeReference: false }], drafts: [{ itemId: 'memory', targetName: 'ImportedNotes', choice: null }] })
  mount(); await screen.findByText('MEMORY.md')
  fireEvent.click(screen.getByRole('button', { name: 'batch.options' }))
  expect(screen.getByRole('button', { name: 'batch.save_options' })).toBeDisabled()
  expect(screen.queryByText('asset_enable')).toBeNull()
  expect(screen.getByLabelText('mapping')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('mapping'), { target: { value: 'current_workspace' } })
  fireEvent.click(screen.getByRole('button', { name: 'batch.save_options' }))
  fireEvent.click(screen.getByRole('button', { name: 'batch.plan' }))
  await waitFor(() => expect(api.planBatch).toHaveBeenCalledOnce())
  expect(api.planBatch.mock.calls[0][0].choices).toEqual([{ kind: 'asset', itemId: 'memory', targetName: 'ImportedNotes', enableAfterImport: false, memoryMapping: 'current_workspace' }])
})

test('a template guides users to its connection page and preserves both explicit choices across pagination', async () => {
  mount()
  await screen.findByText('Office')
  await nextTemplate()
  expect(screen.getByRole('button', { name: 'batch.save_options' })).toBeDisabled()
  expect(screen.queryByText('asset_enable')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'template.open_provider' }))
  await waitFor(() => expect(screen.getByTestId('migration-content-item')).toHaveFocus())
  await configureProvider()
  await nextTemplate()
  fireEvent.change(screen.getByLabelText('template.name'), {
    target: { value: 'Invalid Template' },
  })
  expect(screen.getByRole('button', { name: 'batch.save_options' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('template.name'), { target: { value: 'office-review' } })
  fireEvent.click(screen.getByRole('button', { name: 'batch.save_options' }))
  fireEvent.click(screen.getByRole('button', { name: 'batch.plan' }))
  await waitFor(() => expect(api.planBatch).toHaveBeenCalledOnce())
  expect(api.planBatch.mock.calls[0][0].choices).toEqual([
    {
      kind: 'provider',
      itemId: 'provider',
      targetName: 'ImportedOffice',
      endpoint: 'https://example.invalid/v1',
      model: 'office-model',
      contextWindowTokens: 128000,
      outputHeadroomTokens: 8192,
      maxOutputTokens: 8192,
    },
    {
      kind: 'template',
      itemId: 'template',
      targetName: 'office-review',
      providerItemId: 'provider',
    },
  ])
  expect(api.items).toHaveBeenCalledWith({
    jobId: 'owned-job',
    pageIndex: 1,
    includeTemplates: true,
  })
})

test('deselecting the connection also removes its template selection without silently choosing another connection', async () => {
  mount()
  await configureProvider()
  await nextTemplate()
  fireEvent.click(screen.getByRole('button', { name: 'batch.save_options' }))
  fireEvent.click(screen.getByRole('button', { name: 'previous' }))
  await screen.findByText('Office')
  fireEvent.click(
    within(screen.getByTestId('migration-content-item')).getByRole('checkbox', {
      name: 'batch.select_item',
    })
  )
  await nextTemplate()
  expect(screen.getByRole('checkbox', { name: 'batch.select_item' })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'batch.save_options' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'batch.plan' })).toBeDisabled()
  expect(api.planBatch).not.toHaveBeenCalled()
})

test('an owned saved MCP exposes private-field recovery from a batch record', async () => {
  const saved = {
    ...job,
    job: {
      ...job.job,
      status: 'completed_with_issues',
      sequence: 9,
      totalItems: 1,
      committedItems: 1,
    },
    batch: { ...job.batch, planId: 'batch-plan', selectedItems: 1 },
  }
  api.read.mockResolvedValue(saved)
  api.items.mockResolvedValue({
    items: [
      {
        id: 'saved-mcp',
        category: 'mcp',
        sourceName: 'docs',
        status: 'committed',
        selectedByDefault: false,
        issues: [],
      },
    ],
    providers: [],
    mcps: [
      {
        itemId: 'saved-mcp',
        name: 'docs',
        transport: 'stdio',
        requiredEnv: ['TOKEN'],
        requiredHeaders: [],
      },
    ],
  })
  api.readMcpCredentials.mockResolvedValue({ job: saved.job, plans: [] })
  render(
    <MigrationBatchWorkspace
      deviceId="target"
      workspacePath="/owned"
      isCurrent={() => true}
      onBusy={() => {}}
      initialJobId="owned-job"
      onOpenRecord={() => {}}
      onLegacy={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'mcp_credential.open' }))
  await screen.findByRole('group', { name: 'mcp_credential.fields' })
  expect(api.readMcpCredentials).toHaveBeenCalledWith(
    'owned-job',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
})

const privateMcp = {
  itemId: 'private-mcp',
  name: 'docs',
  transport: 'stdio',
  command: 'never-run',
  url: '',
  cwd: null,
  sourceCwd: null,
  enabledInSource: true,
  requiredEnv: ['TOKEN', 'OTHER'],
  requiredHeaders: [],
}
const privatePlan = {
  planId: 'private-plan',
  itemId: 'private-mcp',
  targetName: 'ImportedDocs',
  transport: 'stdio',
  storage: 'file',
  fields: [{ kind: 'environment', name: 'TOKEN' }],
  remainingFields: 1,
  phase: 'ready',
  undoRequested: false,
  errorCode: null,
}
function privatePage(status = 'discovered') {
  return {
    items: [
      {
        id: 'private-mcp',
        sourceName: 'docs',
        category: 'mcp',
        status,
        selectedByDefault: true,
        issues: [],
      },
    ],
    mcps: [privateMcp],
    drafts: [
      {
        itemId: 'private-mcp',
        targetName: 'ImportedDocs',
        choice: {
          kind: 'mcp',
          itemId: 'private-mcp',
          targetName: 'ImportedDocs',
          enableAfterImport: false,
        },
      },
    ],
  }
}

test('initial batch MCP fields start empty and reach the preview only after explicit field consent', async () => {
  const scanned = { ...job, batch: { ...job.batch, defaultItemIds: ['private-mcp'] } }
  const planned = {
    ...scanned,
    job: { ...job.job, sequence: 2 },
    batch: {
      ...scanned.batch,
      planId: 'owned-plan',
      atomicCredentials: true,
      selectedItems: 1,
    },
  }
  api.read.mockResolvedValue(scanned)
  api.items.mockResolvedValue(privatePage())
  api.planBatch.mockResolvedValue(planned)
  api.readBatchMcpCredentials
    .mockResolvedValueOnce({ job: scanned.job, plans: [] })
    .mockResolvedValue({ job: planned.job, plans: [privatePlan] })
  mount()
  fireEvent.click(await screen.findByText(/batch_mcp.choose/))
  const fields = await screen.findByRole('group', { name: 'mcp_credential.fields' })
  expect(within(fields).getByLabelText(/TOKEN/)).not.toBeChecked()
  expect(within(fields).getByLabelText(/OTHER/)).not.toBeChecked()
  fireEvent.click(within(fields).getByLabelText(/TOKEN/))
  expect(screen.getByRole('button', { name: 'batch.plan' })).toBeDisabled()
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'batch.plan' }))
  await screen.findByTestId('migration-batch-mcp-credentials')
  expect(api.planBatch.mock.calls[0][0].mcpCredentials).toEqual([
    {
      itemId: 'private-mcp',
      fields: [{ kind: 'environment', name: 'TOKEN' }],
      consentPrivateValues: true,
    },
  ])
  expect(screen.getByText('batch_mcp.grouped')).toBeInTheDocument()
  expect(screen.getByText('credential.file_notice')).toBeInTheDocument()
})

test('a restored grouped MCP shows readonly metadata and never offers standalone private mutations', async () => {
  const saved = {
    ...job,
    job: { ...job.job, status: 'completed_with_issues', sequence: 9, committedItems: 1 },
    batch: { ...job.batch, planId: 'owned-plan', atomicCredentials: true, selectedItems: 1 },
  }
  api.read.mockResolvedValue(saved)
  api.items.mockResolvedValue(privatePage('committed'))
  api.readBatchMcpCredentials.mockResolvedValue({
    job: saved.job,
    plans: [{ ...privatePlan, phase: 'published' }],
  })
  mount()
  const details = await screen.findByTestId('migration-batch-mcp-credentials')
  expect(within(details).getByText('ImportedDocs')).toBeInTheDocument()
  expect(within(details).getByText('TOKEN')).toBeInTheDocument()
  expect(within(details).getByText('batch_mcp.remaining')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'mcp_credential.open' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'mcp_credential.undo' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'rollback' })).toBeInTheDocument()
  expect(api.readMcpCredentials).not.toHaveBeenCalled()
  expect(api.planBatch).not.toHaveBeenCalled()
})

test('unknown private metadata blocks final confirmation until an explicit readonly refresh succeeds', async () => {
  const ready = {
    ...job,
    batch: { ...job.batch, planId: 'owned-plan', atomicCredentials: true, selectedItems: 1 },
  }
  api.read.mockResolvedValue(ready)
  api.items.mockResolvedValue(privatePage())
  api.readBatchMcpCredentials
    .mockRejectedValueOnce(new Error('transport interrupted'))
    .mockResolvedValue({ job: ready.job, plans: [privatePlan] })
  mount()
  const message = await screen.findByText('batch_mcp.read_failed')
  expect(screen.getByRole('button', { name: 'batch.apply' })).toBeDisabled()
  fireEvent.click(within(message.parentElement!).getByRole('button', { name: 'refresh' }))
  await screen.findByTestId('migration-batch-mcp-credentials')
  expect(screen.getByRole('button', { name: 'batch.apply' })).toBeEnabled()
  expect(api.readBatchMcpCredentials).toHaveBeenCalledTimes(2)
  expect(api.planBatch).not.toHaveBeenCalled()
})

test.each(['agent', 'hook'] as const)('a %s definition remains a disabled pending asset even when an old local choice claimed enabled', async category => {
  api.items.mockResolvedValue({ items: [{ id: 'definition', sourceName: 'Source definition', category, status: 'requires_action', selectedByDefault: false, issues: [] }],
    assets: [{ itemId: 'definition', name: 'pending-definition', bytes: 40, files: 1, nativeReference: false }],
    drafts: [{ itemId: 'definition', targetName: 'pending-definition', choice: { kind: 'asset', itemId: 'definition', targetName: 'pending-definition', enableAfterImport: true } }] })
  mount(); await screen.findByText('Source definition')
  fireEvent.click(screen.getByRole('button', { name: 'batch.options' }))
  expect(screen.queryByText('asset_enable')).toBeNull()
  expect(screen.getAllByText('definitionsPending').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'batch.save_options' }))
  fireEvent.click(screen.getByRole('button', { name: 'batch.plan' }))
  await waitFor(() => expect(api.planBatch).toHaveBeenCalledOnce())
  expect(api.planBatch.mock.calls[0][0].choices).toEqual([{ kind: 'asset', itemId: 'definition', targetName: 'pending-definition', enableAfterImport: false }])
})

test('ordinary scan uses target defaults until selected and sends the exact explicit initial limits after validation', async () => {
  api.discover.mockResolvedValue({ sources: [{ sourceId: 'source', kind: 'claude-code', displayName: 'Owned source', scope: 'user' }], problems: [] })
  api.scanBatch.mockResolvedValue(job)
  render(<MigrationBatchWorkspace deviceId="target" workspacePath="/owned" isCurrent={() => true} onBusy={() => {}} onOpenRecord={() => {}} onLegacy={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: 'find', exact: true }))
  await screen.findByText('Owned source · user')
  fireEvent.click(screen.getByTestId('migration-initial-enabled'))
  fireEvent.change(screen.getByTestId('migration-initial-maxTotalBytes'), { target: { value: '0' } })
  expect(screen.getByTestId('migration-initial-scan')).toBeDisabled()
  expect(api.scanBatch).not.toHaveBeenCalled()
  fireEvent.change(screen.getByTestId('migration-initial-maxTotalBytes'), { target: { value: '4194304' } })
  fireEvent.change(screen.getByTestId('migration-initial-maxPayloadFiles'), { target: { value: '16' } })
  fireEvent.change(screen.getByTestId('migration-initial-minFreeBytes'), { target: { value: '1048576' } })
  fireEvent.change(screen.getByTestId('migration-initial-minFreeFileNodes'), { target: { value: '0' } })
  fireEvent.click(screen.getByTestId('migration-initial-scan'))
  await waitFor(() => expect(api.scanBatch).toHaveBeenCalledOnce())
  expect(api.scanBatch).toHaveBeenCalledWith({ sourceIds: ['source'], resourceLimits: { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 } })
})

test('an ordinary default scan omits resourceLimits instead of substituting frontend defaults', async () => {
  api.discover.mockResolvedValue({ sources: [{ sourceId: 'source', kind: 'claude-code', displayName: 'Owned source', scope: 'user' }], problems: [] })
  api.scanBatch.mockResolvedValue(job)
  render(<MigrationBatchWorkspace deviceId="target" workspacePath="/owned" isCurrent={() => true} onBusy={() => {}} onOpenRecord={() => {}} onLegacy={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: 'find', exact: true }))
  await screen.findByText('Owned source · user')
  fireEvent.click(screen.getByTestId('migration-initial-scan'))
  await waitFor(() => expect(api.scanBatch).toHaveBeenCalledOnce())
  expect(api.scanBatch).toHaveBeenCalledWith({ sourceIds: ['source'] })
})

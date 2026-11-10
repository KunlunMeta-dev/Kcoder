import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationMcpCredentialPanel } from './MigrationMcpCredentialPanel'
import type {
  MigrationJobReadResult,
  MigrationMcpCandidate,
  MigrationMcpCredentialsResult,
  MigrationMcpCredentialPlanSummary,
} from '../../../../shared/generated/contracts'

const { api } = vi.hoisted(() => ({
  api: {
    readMcpCredentials: vi.fn(),
    planMcpCredentials: vi.fn(),
    applyMcpCredentials: vi.fn(),
    undoMcpCredentials: vi.fn(),
  },
}))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const job = {
  job: {
    jobId: 'owned-job',
    sourceId: 'source',
    sequence: 4,
    status: 'completed_with_issues',
    totalItems: 1,
    committedItems: 1,
    requiresActionItems: 1,
    hasUnconfirmedOutcomes: false,
  },
  source: 'codex',
  plans: [],
  mcpPlans: [],
  issues: [],
} as MigrationJobReadResult
const candidate = {
  itemId: 'mcp',
  name: 'docs',
  transport: 'stdio',
  command: 'never-run',
  url: '',
  cwd: null,
  sourceCwd: null,
  enabledInSource: true,
  requiredEnv: ['TOKEN', 'OTHER'],
  requiredHeaders: [],
} as MigrationMcpCandidate
const plan = {
  planId: 'cred-operation',
  itemId: 'mcp',
  targetName: 'ImportedDocs',
  transport: 'stdio',
  storage: 'file',
  fields: [{ kind: 'environment', name: 'TOKEN' }],
  remainingFields: 1,
  phase: 'ready',
  undoRequested: false,
  errorCode: null,
} as MigrationMcpCredentialPlanSummary
const value = (
  phase?: MigrationMcpCredentialPlanSummary['phase'],
  sequence = 4,
  undoRequested = false
): MigrationMcpCredentialsResult => ({
  job: { ...job.job, sequence },
  plans: phase ? [{ ...plan, phase, undoRequested }] : [],
})
const props = () => ({
  deviceId: 'target',
  workspacePath: '/owned',
  job,
  itemId: 'mcp',
  candidate,
  isCurrent: () => true,
  onUpdated: vi.fn(),
  onBusy: vi.fn(),
  onClose: vi.fn(),
})
beforeEach(() => {
  vi.resetAllMocks()
  api.readMcpCredentials.mockResolvedValue(value())
  api.planMcpCredentials.mockResolvedValue(value('ready', 5))
})

test('slot selection and fresh consent gate a preview that never carries private values', async () => {
  const parameters = props()
  render(<MigrationMcpCredentialPanel {...parameters} />)
  const preview = await screen.findByRole('button', { name: 'mcp_credential.preview' })
  expect(preview).toBeDisabled()
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText(/TOKEN/))
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(screen.getByLabelText(/OTHER/))
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText(/OTHER/))
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(preview)
  await screen.findByText('ImportedDocs')
  expect(api.planMcpCredentials).toHaveBeenCalledWith({
    jobId: 'owned-job',
    expectedSequence: 4,
    itemId: 'mcp',
    fields: [{ kind: 'environment', name: 'TOKEN' }],
    consentPrivateValues: true,
  })
  expect(api.applyMcpCredentials).not.toHaveBeenCalled()
  expect(document.querySelector('input[type=password]')).toBeNull()
  expect(screen.getByText('mcp_credential.remaining')).toBeInTheDocument()
  api.applyMcpCredentials.mockResolvedValue(value('published', 6))
  fireEvent.click(screen.getByRole('button', { name: 'mcp_credential.apply' }))
  await screen.findByText('mcp_credential.phases.published')
  expect(api.applyMcpCredentials).toHaveBeenCalledWith({
    jobId: 'owned-job',
    planId: 'cred-operation',
    expectedSequence: 5,
  })
  expect(parameters.onUpdated).toHaveBeenLastCalledWith(
    expect.objectContaining({ job: expect.objectContaining({ sequence: 6 }) })
  )
})

test('lost undo replies recover metadata and retain undo identity after remount', async () => {
  api.readMcpCredentials
    .mockResolvedValueOnce(value('published', 6))
    .mockResolvedValue(value('undoing', 8, true))
  api.undoMcpCredentials.mockRejectedValueOnce(new Error('response lost'))
  const first = render(<MigrationMcpCredentialPanel {...props()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'mcp_credential.undo' }))
  await screen.findByText('mcp_credential.phases.undoing')
  expect(api.undoMcpCredentials).toHaveBeenCalledTimes(1)
  expect(api.applyMcpCredentials).not.toHaveBeenCalled()
  first.unmount()
  render(<MigrationMcpCredentialPanel {...props()} />)
  const resume = await screen.findByRole('button', { name: 'mcp_credential.resume_undo' })
  api.undoMcpCredentials.mockResolvedValue(value('undone', 10, true))
  fireEvent.click(resume)
  await screen.findByText('mcp_credential.phases.undone')
  expect(api.undoMcpCredentials.mock.calls[1][0]).toEqual({
    jobId: 'owned-job',
    planId: 'cred-operation',
    expectedSequence: 8,
  })
  expect(api.applyMcpCredentials).not.toHaveBeenCalled()
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
})

test('a replaced account cannot update the current job and cleanup aborts only its own read', async () => {
  let active = true
  let finish!: (value: MigrationMcpCredentialsResult) => void
  api.readMcpCredentials.mockImplementationOnce(
    (_id, options) =>
      new Promise(resolve => {
        finish = resolve
        expect(options.signal.aborted).toBe(false)
      })
  )
  const parameters = { ...props(), isCurrent: () => active }
  const page = render(<MigrationMcpCredentialPanel {...parameters} />)
  await waitFor(() => expect(api.readMcpCredentials).toHaveBeenCalledOnce())
  const signal = api.readMcpCredentials.mock.calls[0][1].signal
  active = false
  page.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => finish(value('published', 6)))
  expect(parameters.onUpdated).not.toHaveBeenCalled()
  expect(api.undoMcpCredentials).not.toHaveBeenCalled()
})

test('old targets show an upgrade error while preserving a closable panel and no writes', async () => {
  api.readMcpCredentials.mockRejectedValue(new Error('migration_update_required'))
  const parameters = props()
  render(<MigrationMcpCredentialPanel {...parameters} />)
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('errors.migration_update_required')
  fireEvent.click(screen.getByRole('button', { name: 'close' }))
  expect(parameters.onClose).toHaveBeenCalledOnce()
  expect(api.planMcpCredentials).not.toHaveBeenCalled()
})

test('a lost save response is settled by reading its receipt without a second write', async () => {
  api.readMcpCredentials
    .mockResolvedValueOnce(value('ready', 5))
    .mockResolvedValue(value('published', 7))
  api.applyMcpCredentials.mockRejectedValue(new Error('transport lost'))
  render(<MigrationMcpCredentialPanel {...props()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'mcp_credential.apply' }))
  await screen.findByText('mcp_credential.phases.published')
  expect(api.applyMcpCredentials).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('a mutation response from a replaced account never updates this workspace', async () => {
  let active = true
  let finish!: (value: MigrationMcpCredentialsResult) => void
  api.planMcpCredentials.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const parameters = { ...props(), isCurrent: () => active }
  render(<MigrationMcpCredentialPanel {...parameters} />)
  await screen.findByRole('button', { name: 'mcp_credential.preview' })
  parameters.onUpdated.mockClear()
  fireEvent.click(screen.getByLabelText(/TOKEN/))
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'mcp_credential.preview' }))
  await waitFor(() => expect(api.planMcpCredentials).toHaveBeenCalledOnce())
  active = false
  await act(async () => finish(value('ready', 7)))
  expect(parameters.onUpdated).not.toHaveBeenCalled()
  expect(api.applyMcpCredentials).not.toHaveBeenCalled()
})

test('a lost preview reply restores its existing plan and requires explicit save', async () => {
  api.readMcpCredentials.mockResolvedValueOnce(value()).mockResolvedValue(value('ready', 6))
  api.planMcpCredentials.mockRejectedValue(new Error('response lost'))
  render(<MigrationMcpCredentialPanel {...props()} />)
  await screen.findByRole('button', { name: 'mcp_credential.preview' })
  fireEvent.click(screen.getByLabelText(/TOKEN/))
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'mcp_credential.preview' }))
  await screen.findByText('mcp_credential.phases.ready')
  expect(api.planMcpCredentials).toHaveBeenCalledTimes(1)
  expect(api.applyMcpCredentials).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('bulk selection stays local and always requires a fresh consent', async () => {
  render(<MigrationMcpCredentialPanel {...props()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'mcp_credential.select_all' }))
  expect(screen.getByLabelText(/TOKEN/)).toBeChecked()
  expect(screen.getByLabelText(/OTHER/)).toBeChecked()
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('mcp_credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'mcp_credential.select_none' }))
  expect(screen.getByLabelText('mcp_credential.consent')).not.toBeChecked()
  expect(screen.getByLabelText(/TOKEN/)).not.toBeChecked()
  expect(api.planMcpCredentials).not.toHaveBeenCalled()
})

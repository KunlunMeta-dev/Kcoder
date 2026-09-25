import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WorkflowReusePicker } from './WorkflowReusePicker'
import { workflowApi, type WorkflowSummary, type WorkflowDefinition } from './workflowApi'
let active = true
const isCurrent = () => active
const t = (key: string, params?: { params?: string }) => params?.params ?? key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'scope', isCurrent }),
}))
vi.mock('./workflowApi', () => ({
  workflowApi: { list: vi.fn(), versions: vi.fn(), exportDefinition: vi.fn() },
}))
const item = {
  id: 'saved',
  title: 'Slides',
  description: 'Make slides',
  savedVersion: 2,
  status: 'draft',
} as WorkflowSummary
beforeEach(() => {
  active = true
  vi.clearAllMocks()
  vi.mocked(workflowApi.list).mockResolvedValue({
    items: [item, { ...item, id: 'draft', title: 'Unpublished', savedVersion: null }],
    total: 2,
    truncated: false,
  })
  vi.mocked(workflowApi.versions).mockResolvedValue(
    [1, 2].map(version => ({
      version,
      revision: version,
      title: 'Slides',
      nodeCount: 3,
      savedAtMs: 1,
    }))
  )
  vi.mocked(workflowApi.exportDefinition).mockImplementation(
    async (_server, id, version) =>
      ({
        id,
        savedVersion: version,
        title: `Slides v${version}`,
        description: 'Saved description',
        nodes: [],
      }) as WorkflowDefinition
  )
})
test('only saved versions can be inserted, including a previous version, without executing', async () => {
  const insert = vi.fn()
  render(<WorkflowReusePicker serverId="remote" disabled={false} onInsert={insert} />)
  fireEvent.click(screen.getByTestId('workflow-reuse-open'))
  fireEvent.click(await screen.findByTestId('workflow-reuse-saved'))
  expect(screen.queryByText('Unpublished')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('workflow-reuse-version')).toHaveValue('2'))
  fireEvent.change(screen.getByTestId('workflow-reuse-version'), { target: { value: '1' } })
  await screen.findByTestId('workflow-reuse-preview')
  fireEvent.click(screen.getByTestId('workflow-reuse-parameters-toggle'))
  fireEvent.change(screen.getByTestId('workflow-reuse-args'), { target: { value: '[]' } })
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(insert).not.toHaveBeenCalled()
  expect(
    screen
      .getAllByRole('alert')
      .some(item => item.textContent?.includes('workflowReuse.objectRequired'))
  ).toBe(true)
  fireEvent.change(screen.getByTestId('workflow-reuse-args'), {
    target: { value: '{"topic":"AI"}' },
  })
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(JSON.parse(insert.mock.calls[0][0])).toEqual({
    definition_id: 'saved',
    version: 1,
    args: { topic: 'AI' },
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
test('read failure is retryable and late account-scoped responses are ignored', async () => {
  vi.mocked(workflowApi.list).mockRejectedValueOnce(new Error('offline'))
  render(<WorkflowReusePicker serverId="remote" disabled={false} onInsert={vi.fn()} />)
  fireEvent.click(screen.getByTestId('workflow-reuse-open'))
  expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  fireEvent.click(screen.getByText('workflowCanvas.reload'))
  fireEvent.click(await screen.findByTestId('workflow-reuse-saved'))
  await waitFor(() => expect(screen.getByTestId('workflow-reuse-version')).toHaveValue('2'))
  active = false
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('conversation is the default even with missing required arguments; optional forms use exact saved defaults', async () => {
  vi.mocked(workflowApi.exportDefinition).mockImplementation(
    async (_server, id, version) =>
      ({
        id,
        savedVersion: version,
        title: 'Published',
        nodes: [],
        inputSchema: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic: { type: 'string', title: 'Topic', minLength: 2 },
            pages: { type: 'integer', minimum: 1, default: 8 },
            notes: { type: 'boolean', default: false },
          },
        },
      }) as WorkflowDefinition
  )
  const insert = vi.fn()
  render(<WorkflowReusePicker serverId="remote" disabled={false} onInsert={insert} />)
  fireEvent.click(screen.getByTestId('workflow-reuse-open'))
  fireEvent.click(await screen.findByTestId('workflow-reuse-saved'))
  await screen.findByTestId('workflow-reuse-preview')
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(JSON.parse(insert.mock.calls[0][0])).toEqual({ definition_id: 'saved', version: 2 })
  fireEvent.click(screen.getByTestId('workflow-reuse-open'))
  fireEvent.click(await screen.findByTestId('workflow-reuse-saved'))
  await screen.findByTestId('workflow-reuse-preview')
  fireEvent.click(screen.getByTestId('workflow-reuse-parameters-toggle'))
  expect(screen.getByTestId('workflow-arg-pages')).toHaveValue('8')
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(insert).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByTestId('workflow-arg-topic'), { target: { value: 'AI' } })
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(JSON.parse(insert.mock.calls[1][0]).args).toEqual({ pages: 8, notes: false, topic: 'AI' })
})

test('late historical-version reads cannot overwrite the current version or its arguments', async () => {
  let resolveOld!: (value: WorkflowDefinition) => void
  vi.mocked(workflowApi.exportDefinition).mockImplementation(async (_server, id, version) => {
    if (version === 1)
      return new Promise<WorkflowDefinition>(resolve => {
        resolveOld = resolve
      })
    return {
      id,
      savedVersion: version,
      title: 'Current saved version',
      nodes: [],
    } as WorkflowDefinition
  })
  const insert = vi.fn()
  render(<WorkflowReusePicker serverId="remote" disabled={false} onInsert={insert} />)
  fireEvent.click(screen.getByTestId('workflow-reuse-open'))
  fireEvent.click(await screen.findByTestId('workflow-reuse-saved'))
  await screen.findByTestId('workflow-reuse-preview')
  fireEvent.change(screen.getByTestId('workflow-reuse-version'), { target: { value: '1' } })
  expect(screen.getByTestId('workflow-reuse-insert')).toBeDisabled()
  fireEvent.change(screen.getByTestId('workflow-reuse-version'), { target: { value: '2' } })
  await screen.findByTestId('workflow-reuse-preview')
  resolveOld({
    id: 'saved',
    savedVersion: 1,
    title: 'Stale version',
    nodes: [],
  } as WorkflowDefinition)
  await waitFor(() => expect(screen.queryByText('Stale version')).not.toBeInTheDocument())
  fireEvent.click(screen.getByTestId('workflow-reuse-insert'))
  expect(JSON.parse(insert.mock.calls[0][0]).version).toBe(2)
})

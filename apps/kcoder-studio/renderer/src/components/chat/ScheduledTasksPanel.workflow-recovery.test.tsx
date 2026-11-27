import { beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import type { WorkflowCreationLocator } from '@/kcoder/automationCreationPending'
import {
  automationPendingKey,
  readAutomationPending,
  saveAutomationPending,
} from '@/kcoder/automationCreationPending'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'
const fixture = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), cron: vi.fn() }))
vi.mock('./createScheduledWorkflowTask', () => ({
  createScheduledWorkflowTask: fixture.create,
  readScheduledWorkflowCreation: fixture.read,
}))
vi.mock('./ScheduledWorkflowTasks', () => ({
  ScheduledWorkflowTasks: ({ onChoiceChange }: { onChoiceChange: (value: unknown) => void }) => (
    <button
      onClick={() =>
        onChoiceChange({
          id: 'saved',
          version: 1,
          title: 'Owned workflow',
          definition: {},
          isCurrent: () => true,
        })
      }
    >
      Select workflow
    </button>
  ),
}))
vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<typeof import('@/kcoder/gatewayRpc')>()),
  fetchGatewayServers: vi.fn(async () => [{ id: 'local', transport: 'local' }]),
}))
vi.mock('@/kcoder/gatewayAutomationApi', async original => ({
  ...(await original<typeof import('@/kcoder/gatewayAutomationApi')>()),
  requestAutomation: fixture.cron,
}))
const work = {
  projects: [],
  totalTasks: 1,
  chats: [{ deviceId: 'local', workspacePath: '/owned', tasks: [] }],
} as unknown as RuntimeWorkListResponse
const locator: WorkflowCreationLocator = {
  kind: 'workflow',
  operationId: 'original-operation',
  subscriptionId: 'original-subscription',
  owner: { accountId: 'owned', targetId: 'local', workspaceId: '/owned' },
}
const key = automationPendingKey({ id: 'local', transport: 'local' }, '/owned')
beforeEach(() => {
  sessionStorage.clear()
  fixture.create.mockReset().mockImplementation(async ({ onPrepared }) => {
    onPrepared(locator)
    throw new KnowledgeOperationError('KNOWLEDGE_CONNECTION_UNAVAILABLE', locator.operationId, true)
  })
  fixture.read.mockReset().mockResolvedValue(false)
  fixture.cron
    .mockReset()
    .mockImplementation(async (_address, method) =>
      method === 'cron/preview' ? { nextRunAt: '2035-01-01T09:00:00Z' } : { jobs: [] }
    )
})
async function create() {
  await waitFor(() => expect(screen.getByTestId('automation-prompt')).not.toBeDisabled())
  fireEvent.change(screen.getByTestId('scheduled-task-kind'), { target: { value: 'workflow' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Select workflow' }))
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: '2035-01-01T09:00' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByText(/原操作结果尚未确认/)
}
test('workflow uncertainty survives remount and reads its original subscription, never a cron receipt', async () => {
  const first = render(<ScheduledTasksPanel runtimeWork={work} />)
  await create()
  expect(JSON.parse(readAutomationPending(key)!)).toEqual(locator)
  first.unmount()
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await screen.findByText(/原操作结果尚未确认/)
  expect(screen.getByTestId('automation-create')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '核对任务与运行记录' })).toBeEnabled()
  )
  expect(screen.getByText(/原操作结果尚未确认/)).toBeInTheDocument()
  fixture.read.mockResolvedValueOnce(true)
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await waitFor(() => expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument())
  expect(fixture.read).toHaveBeenLastCalledWith(
    { deviceId: 'local', workspacePath: '/owned' },
    locator,
    expect.any(Function)
  )
  expect(readAutomationPending(key)).toBeNull()
  expect(fixture.create).toHaveBeenCalledOnce()
  expect(
    fixture.cron.mock.calls.some(
      ([, method, params]) => method === 'cron/create' || params?.clientRequestId
    )
  ).toBe(false)
})
test('a late workflow receipt cannot clear a replacement pending operation', async () => {
  let finish!: (value: boolean) => void
  fixture.read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await create()
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce())
  sessionStorage.removeItem(key)
  saveAutomationPending(key, { ...locator, operationId: 'replacement' })
  finish(true)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '核对任务与运行记录' })).toBeEnabled()
  )
  expect(JSON.parse(readAutomationPending(key)!).operationId).toBe('replacement')
  expect(screen.getByText(/原操作结果尚未确认/)).toBeInTheDocument()
})
test('a definite workflow rejection clears only its pending locator', async () => {
  fixture.create.mockImplementationOnce(async ({ onPrepared }) => {
    onPrepared(locator)
    throw new KnowledgeOperationError('AUTOMATION_INVALID_INPUTS', locator.operationId, false)
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(screen.getByTestId('automation-prompt')).not.toBeDisabled())
  fireEvent.change(screen.getByTestId('scheduled-task-kind'), { target: { value: 'workflow' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Select workflow' }))
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: '2035-01-01T09:00' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByRole('alert')
  expect(readAutomationPending(key)).toBeNull()
  expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument()
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskWorkflowViewer } from './TaskWorkflowViewer'
import type { FixedWorkflowRun } from '@/features/workflows/fixedWorkflowRun'
import type { WorkflowRun } from '@/features/workflows/workflowApi'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string, workspace: string) => ({
    key: JSON.stringify([serverId, workspace]), isCurrent: f.current,
  }),
}))
const reference: FixedWorkflowRun = {
  kind: 'workflow_run', threadId: 'original-thread', runId: 'original-run',
  revision: 3, definitionRef: { id: 'original-definition', revision: '2' },
}
const run: WorkflowRun = {
  runId: reference.runId, threadId: reference.threadId,
  definitionId: 'original-definition', version: 2, revision: 4, workspace: '/owned',
  status: 'completed', resumeCount: 1, startedAtMs: 1, updatedAtMs: 2,
  nodeStates: [{ nodeId: 'review', agentId: 'legacy-agent-id-only', status: 'completed',
    attempt: 2, iteration: null, startedAtMs: 1, finishedAtMs: 2,
    reused: true, outputPreview: 'original output observation', error: null }],
}
afterEach(() => { cleanup(); f.request.mockReset() })
function renderOriginal(props: Partial<React.ComponentProps<typeof TaskWorkflowViewer>> = {}) {
  return render(<TaskWorkflowViewer target={{ serverId: 'native', workspacePath: '/owned' }}
    reference={reference} onClose={vi.fn()} {...props} />)
}
test('fixed run reuses the normal inspector and original paged output without list/latest or execution controls', async () => {
  f.request.mockImplementation(async (_method, scope) => {
    if (scope.method === 'workflow/runs/read') return run
    if (scope.method === 'workflow/runs/output') return { text: 'actual original output page', truncated: false }
    throw new Error('Unexpected write, latest or unsupported selector')
  })
  const open = vi.fn()
  renderOriginal({ onOpenThread: open })
  await screen.findByText('original output observation')
  expect(f.request).toHaveBeenCalledWith('runtime.workflows.request', {
    serverId: 'native', method: 'workflow/runs/read', params: { runId: reference.runId },
  }, { signal: expect.any(AbortSignal) })
  for (const id of ['workflow-resume-run', 'workflow-reuse-prefix', 'workflow-run-archive-open', 'workflow-history-agent-review'])
    expect(screen.queryByTestId(id)).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'workflowCanvas.nodeOutput' }))
  await screen.findByText('actual original output page')
  expect(f.request.mock.calls.every(([, scope]) => ['workflow/runs/read', 'workflow/runs/output'].includes(scope.method))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'workflowCanvas.openRunConversation' }))
  expect(open).toHaveBeenCalledOnce()
})
test('another thread, run, fixed version, workspace, or older revision fails without rendering or selecting latest', async () => {
  for (const change of [
    { threadId: 'foreign-thread' }, { runId: 'newer-run' }, { definitionId: 'other-definition' },
    { version: 3 }, { workspace: '/foreign' }, { revision: 2 },
  ]) {
    f.request.mockResolvedValue({ ...run, ...change })
    const view = renderOriginal()
    expect(await screen.findByRole('alert')).toHaveTextContent('workflowFlow.runMismatch')
    expect(screen.queryByText('original output observation')).toBeNull()
    expect(f.request.mock.calls.every(([, scope]) => scope.method === 'workflow/runs/read')).toBe(true)
    view.unmount(); f.request.mockReset()
  }
})
test('late original read cannot enter another selected target or run and no missing callback infers navigation', async () => {
  let release!: (value: WorkflowRun) => void
  f.request.mockImplementation(async (_method, scope) => {
    if (scope.params.runId === reference.runId) return new Promise(resolve => { release = resolve })
    return { ...run, runId: 'other-original-run', nodeStates: [] }
  })
  const view = renderOriginal()
  await waitFor(() => expect(release).toBeTypeOf('function'))
  view.rerender(<TaskWorkflowViewer target={{ serverId: 'other-native', workspacePath: '/owned' }}
    reference={{ ...reference, runId: 'other-original-run' }} onClose={vi.fn()} />)
  await screen.findByText(/other-original-run/)
  release(run)
  await waitFor(() => expect(screen.queryByText('original output observation')).toBeNull())
  expect(screen.queryByRole('button', { name: 'workflowCanvas.openRunConversation' })).toBeNull()
})
test('actual pending human/event records are read-only, unsupported remains unknown and foreign run requests fail', async () => {
  let pending: unknown = { supported: false, requests: [] }
  f.request.mockImplementation(async (_method, scope) => scope.method === 'workflow/runs/read'
    ? { ...run, status: 'running' } : pending)
  const first = renderOriginal()
  await screen.findByText('taskWorkspace:interactionsUnknown')
  expect(screen.queryByText('taskWorkspace:noInteractions')).toBeNull()
  first.unmount()
  pending = { supported: true, requests: [{ runId: reference.runId, requestId: 'request', nodeId: 'review',
    request: { kind: 'human', prompt: 'Review original findings', schema: { type: 'object' } },
    deadlineUnixMs: 12345, status: 'pending' }] }
  const second = renderOriginal()
  await screen.findByText('Review original findings')
  expect(screen.queryByTestId('workflow-submit-response')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  second.unmount()
  pending = { ...pending as object, requests: [{ runId: 'foreign', requestId: 'request', nodeId: 'review',
    request: { kind: 'human', prompt: 'Foreign hidden prompt' }, deadlineUnixMs: 1, status: 'pending' }] }
  renderOriginal()
  expect(await screen.findByRole('alert')).toHaveTextContent('workflowFlow.runMismatch')
  expect(screen.queryByText('Foreign hidden prompt')).toBeNull()
})
test('missing fixed definition never starts an inspector or any request', async () => {
  renderOriginal({ reference: { ...reference, definitionRef: null } })
  await screen.findByRole('alert')
  expect(f.request).not.toHaveBeenCalled()
})

test('failed original run prepares the existing recovery composer without running or selecting another version', async () => {
  f.request.mockResolvedValue({ ...run, status: 'failed' })
  const opened = vi.fn()
  const intents: unknown[] = []
  const observe = (event: Event) => intents.push((event as CustomEvent).detail)
  window.addEventListener('kcoder:workflow-composer-intent', observe)
  try {
    renderOriginal({ onOpenThread: opened })
    fireEvent.click(await screen.findByTestId('task-workflow-prepare-recovery'))
    expect(intents).toEqual([{ active: false, recovery: {
      runId: reference.runId, threadId: reference.threadId, deviceId: 'native',
      definitionId: 'original-definition',
    } }])
    expect(opened).toHaveBeenCalledOnce()
    expect(f.request.mock.calls.every(([, scope]) => scope.method === 'workflow/runs/read')).toBe(true)
    expect(screen.queryByTestId('workflow-run-archive-open')).toBeNull()
  } finally {
    window.removeEventListener('kcoder:workflow-composer-intent', observe)
  }
})

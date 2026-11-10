import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { GoalStatusBar } from '@/components/chat/composer/GoalStatusBar'
import { createTaskGoalObservation, type TaskGoalReference } from '@/kcoder/taskGoalObservation'
import type { RuntimeTaskAddress } from '@/types/api'
import { TaskGoalViewer } from './TaskGoalViewer'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t, i18n: { language: 'en' } }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'owned', isCurrent: f.current }) }))
const address: RuntimeTaskAddress = { deviceId: 'goal-owned', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/owned' }
const reference: TaskGoalReference = { kind: 'goal', threadId: 'original-thread', goalId: 'original-goal', revision: 3 }
const goal = { threadId: reference.threadId, goalId: reference.goalId, revision: 4, objective: 'Original complete Goal objective', mode: 'standard' as const,
  status: 'active' as const, tokensUsed: 22, tokenBudget: null, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2,
  events: [{ kind: 'goal_set', timestamp: 1, summary: 'Original source event' }] }
afterEach(() => { cleanup(); f.request.mockReset(); vi.useRealTimers();vi.restoreAllMocks() })
test('StrictMode reads the exact original Goal with real identity and no editable controls', async () => {
  f.request.mockResolvedValue({ accepted: true, taskId: address.taskId, goal })
  render(<StrictMode><TaskGoalViewer address={address} reference={reference} onClose={vi.fn()} /></StrictMode>)
  await screen.findAllByText(goal.objective)
  await screen.findByText('Original source event')
  for (const id of ['edit-goal-button','pause-goal-button','resume-goal-button','clear-goal-button']) expect(screen.queryByTestId(id)).toBeNull()
  expect(f.request.mock.calls.every(([method]) => method === 'runtime.tasks.goal.get')).toBe(true)
  expect(f.request).toHaveBeenCalledWith('runtime.tasks.goal.get',{address},{signal:expect.any(AbortSignal)})
})
test('read-only active Goal reports the stored time without a simulated live ticker', () => {
  vi.useFakeTimers()
  const interval = vi.spyOn(window,'setInterval')
  render(<GoalStatusBar goal={goal} readOnly />)
  expect(screen.getByText('2s')).toBeInTheDocument()
  act(()=>vi.advanceTimersByTime(9000))
  expect(screen.getByText('2s')).toBeInTheDocument()
  expect(interval).not.toHaveBeenCalled()
})
test('another Goal or thread and an older revision never silently replace the original reference', async () => {
  for (const change of [{goalId:'new-goal'},{threadId:'other-thread'},{revision:2},{status:'unknown'}]) {
    f.request.mockResolvedValue({accepted:true,taskId:address.taskId,goal:{...goal,...change}})
    const reader=createTaskGoalObservation(address,reference,()=>true)
    await expect(reader.read()).rejects.toMatchObject({code:'goalId' in change?'reference_changed':'invalid_reply'})
    reader.dispose()
  }
})
test('missing Goal identity is unsupported and a missing current Goal is not an empty successful replacement', async () => {
  const reader=createTaskGoalObservation(address,reference,()=>true)
  f.request.mockResolvedValue({accepted:true,goal:{...goal,goalId:undefined}})
  await expect(reader.read()).rejects.toMatchObject({code:'unsupported'})
  f.request.mockResolvedValue({accepted:true,goal:null})
  await expect(reader.read()).rejects.toMatchObject({code:'reference_changed'})
  reader.dispose()
})
test('cancel releases the view immediately and discards a late original result', async () => {
  let release!:(value:unknown)=>void
  f.request.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  render(<TaskGoalViewer address={address} reference={reference} onClose={vi.fn()} />)
  await waitFor(()=>expect(release).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button',{name:'cancelRead'}))
  expect(screen.getByRole('alert')).toHaveTextContent('errors.cancelled')
  release({accepted:true,goal})
  await waitFor(()=>expect(screen.queryByText(goal.objective)).toBeNull())
})
test('a refresh retains the last original revision floor rather than accepting a rollback', async () => {
  f.request.mockResolvedValueOnce({accepted:true,goal:{...goal,revision:8}}).mockResolvedValue({accepted:true,goal})
  render(<TaskGoalViewer address={address} reference={reference} onClose={vi.fn()} />)
  await screen.findAllByText(goal.objective)
  fireEvent.click(screen.getByTestId('task-goal-refresh'))
  expect(await screen.findByRole('alert')).toHaveTextContent('errors.invalid_reply')
  expect(screen.queryByText(goal.objective)).toBeNull()
})

import { expect, test } from 'vitest'
import { installedCompatibility, standaloneCompatibility } from './compatibility'
import type { GatewayTask } from './contracts'
import { projectPersistedThread } from './threadSnapshotTask'
import type { GatewayRuntimeCore } from './core'
import type { GatewayServer } from '../../gatewayRpc'

const runtime = {
  compatibility: installedCompatibility,
  activeTurnByTask: new Map(), taskMetadata: new Map(),
  threadKey: (server: string, thread: string) => `${server}\0${thread}`,
} as unknown as GatewayRuntimeCore
const workspace = { server: { id: 'target' } as GatewayServer, workspacePath: '/owned' }
const summary = { mainTurn: 'running', pendingApprovals: 0, pendingQuestions: 0, activeJobs: 0,
  tasksPending: 0, tasksRunning: 0, pendingFollowups: 0, pendingGoals: 0 }

test('an installed client shows a resident background peer turn without a locally open view', () => {
  const thread = { id: 'thread', cwd: '/owned', status: 'running', runSummary: summary }
  const { task } = projectPersistedThread(runtime, workspace, thread, 'task')
  expect(task).toMatchObject({ running: true, runActivity: 'running' })
})

test('an unverified legacy lease or unknown summary does not become a running turn', () => {
  for (const runSummary of [undefined, { ...summary, mainTurn: 'unknown' }, { mainTurn: 'running' }]) {
    const thread = { id: 'thread', cwd: '/owned', status: 'running', runSummary }
    expect(projectPersistedThread(runtime, workspace, thread, 'task').task).toMatchObject({ running: false })
  }
})

test.each([installedCompatibility, standaloneCompatibility])(
  'a confirmed terminal snapshot overrides a stale locally active turn', compatibility => {
    const taskId = 'stale-active-task'
    const scopedRuntime = { ...runtime, compatibility,
      activeTurnByTask: new Map([[taskId, {}]]) } as unknown as GatewayRuntimeCore
    const existing = { taskId, running: true, turnStatus: 'inProgress' } as GatewayTask
    const thread = { id: 'thread', cwd: '/owned', status: 'running',
      runSummary: { ...summary, mainTurn: 'idle', latestTurnStatus: 'failed' } }
    expect(projectPersistedThread(scopedRuntime, workspace, thread, taskId, existing).task)
      .toMatchObject({ running: false, turnStatus: 'failed', runActivity: 'idle' })
  }
)

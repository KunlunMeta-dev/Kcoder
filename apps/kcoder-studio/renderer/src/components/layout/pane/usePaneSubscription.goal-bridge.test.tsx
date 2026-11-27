import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'
import { createGatewayIpcHandler } from '@/kcoder/gatewayRuntimeInstall'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import { requestLocalExecutor } from '@/host/localExecutor'
import { createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { RuntimeGoalScopeRetiredError, RUNTIME_GOAL_SCOPE_RETIRED } from '@/kcoder/goalObservationCancellation'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneRestore } from './usePaneRestore'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks(); localStorage.clear() })
async function chain() {
  const server = { id: 'goal-bridge-native', label: 'Owned Goal bridge', transport: 'local' as const,
    command: '/owned/kcoder-original', workspacePath: '/owned' }
  let delayed = false, resolveGoal!: (value: unknown) => void, rejectGoal!: (error: Error) => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const pendingGoal = new Promise<unknown>((resolve, reject) => { resolveGoal = resolve; rejectGoal = reject })
  class GoalClient extends FakeGatewayClient {
    override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (delayed && method === 'thread/goal/get') { this.requests.push({ method, params }); entered(); return await pendingGoal as T }
      return super.request<T>(method, params)
    }
  }
  const runtime = new KCoderGatewayRuntime('protocol-only-token', { loadServers: async () => [server],
    createClient: () => new GoalClient('goal-bridge-thread') })
  cleanups.push(() => runtime.disposeAsync())
  const created = await runtime.request('runtime.tasks.create', { taskId: 'goal-bridge-task',
    deviceId: server.id, workspacePath: server.workspacePath, executionRequest: { prompt: 'Protocol-only Goal owner' } }) as { taskId: string }
  const unregister = registerGatewayCommandTransport(createGatewayIpcHandler(runtime)); cleanups.push(unregister)
  const api = createRuntimeWorkApiFromIpc(<T,>(method: string, params?: Record<string, unknown>) => requestLocalExecutor<T>(method, params),
    async () => server.id)
  const address = { deviceId: server.id, taskId: created.taskId, runtimeHandle: { threadId: 'goal-bridge-thread' }, workspacePath: '/owned' }
  delayed = true
  return { runtime, server, api, address, ready, resolveGoal, rejectGoal }
}
function pane(f: Awaited<ReturnType<typeof chain>>) {
  const commit = vi.fn(), report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let settled!: () => void
  const reader = vi.fn((address: typeof f.address) => f.api.getRuntimeGoal({ address }))
  const context = { runtimeTaskLoadTargetRef: { current: { identityKey: 'unchanged-owned-pane', key: 'unchanged-owned-pane', address: f.address } },
    subscribeRuntimeTaskStreamRef: { current: vi.fn((_address: unknown, handlers: { onAssistantSettled: () => void }) => { settled = handlers.onAssistantSettled; return vi.fn() }) },
    getRuntimeGoalRef: { current: reader }, goalRevisionRef: { current: 0 }, setSubagentStatuses: vi.fn(), commitThreadGoal: commit,
    lifecycleStore: { goalStatusReceived: vi.fn() }, refreshWorkListsRef: { current: vi.fn().mockResolvedValue(undefined) }, setPendingGoalState: vi.fn(),
  } as unknown as ReturnType<typeof usePaneRestore>
  const hook = renderHook(() => usePaneSubscription(context)); cleanups.push(hook.unmount)
  act(() => settled())
  return { commit, report, reader }
}
test('real Core to IPC bridge and local Runtime API preserve the dedicated scope cancellation type and code', async () => {
  const f = await chain(), pending = f.api.getRuntimeGoal({ address: f.address })
  const rejected = expect(pending).rejects.toBeInstanceOf(RuntimeGoalScopeRetiredError)
  await f.ready; f.server.command = '/owned/kcoder-replaced'; f.resolveGoal({ goal: null })
  await rejected
  await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: RUNTIME_GOAL_SCOPE_RETIRED })
})
test('real Core target retirement crossing invoke is quiet in the still-current pane without adopting a Goal', async () => {
  const f = await chain(), p = pane(f)
  await f.ready
  const cancelled = expect(p.reader.mock.results[0].value).rejects.toMatchObject({ code: RUNTIME_GOAL_SCOPE_RETIRED })
  await act(async () => { f.server.command = '/owned/kcoder-replaced'; f.resolveGoal({ goal: null }); await cancelled })
  expect(p.reader).toHaveBeenCalledTimes(1)
  expect(p.commit).not.toHaveBeenCalled(); expect(p.report).not.toHaveBeenCalled()
})
test('real Core current-owner Goal failure crossing invoke remains an error even with the old localized stale message', async () => {
  const f = await chain(), p = pane(f), original = new Error('运行目标或账号已变化，请重新读取工作流库。')
  await f.ready
  await act(async () => { f.rejectGoal(original); await Promise.resolve() })
  await waitFor(() => expect(p.report).toHaveBeenCalledWith('[KCoder Studio] Runtime goal refresh failed', expect.objectContaining({ error: original })))
  expect(p.commit).not.toHaveBeenCalled()
})

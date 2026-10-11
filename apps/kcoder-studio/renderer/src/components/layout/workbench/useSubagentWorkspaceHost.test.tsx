import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSubscription,
  RuntimeSubagentListResponse,
} from '@/types/subagents'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { SubagentCommandJournal } from '@/features/subagents/subagentCommandJournal'
import { useSubagentWorkspaceHost } from './useSubagentWorkspaceHost'

/** QA: host recovery, scoped mutations, structured conversation/history and exact stop CAS.
 * In-memory addressed API tests UI orchestration independently of models.
 * Local journal cleared before every case; timers/hooks unmounted by test cleanup.
 */
describe('actual subagent Workspace host assembly', () => {
  const address = {
    runtime: 'kcoder',
    deviceId: 'target-1',
    taskId: 'task-1',
  } as RuntimeTaskAddress
  const run = { parentSessionId: 'parent', agentId: 'agent-5', runId: 'actual-run' }
  beforeEach(() => localStorage.clear())
  function setup(receipts = true, stop = true, conversationStream = true) {
    const list: RuntimeSubagentListResponse = {
      threadId: 'parent',
      journalScope: 'principal-target-thread',
      capabilities: {
        conversationStream,
        steering: true,
        receipts,
        artifacts: true,
        publicTranscript: true,
        pages: true,
        live: true,
        stop,
      },
      agents: Array.from({ length: 6 }, (_, i) => ({
        agentId: `agent-${i}`,
        status: 'running',
        acceptingMessages: true,
        queueDepth: 0,
        backgroundRun: i === 5 ? run : undefined,
        presentation: { journalScope: `worker-${i}`, canStop: i === 5 },
      })),
    }
    const streams = new Map<string, (event: RuntimeSubagentConversationEvent) => void>()
    const unsubscribe = vi.fn(async () => {})
    const api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (params, handler) => {
        streams.set(params.agentId, handler)
        return {
          snapshot: {
            threadId: 'parent',
            agentId: params.agentId,
            subscriptionId: params.agentId,
            runId: 'actual-run',
            sequence: 0,
            active: true,
            messages: [],
          },
          unsubscribe,
        }
      }),
      listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      listRuntimeSubagentCommands: vi.fn().mockResolvedValue({
        receiptEpoch: 2,
        retainedCount: 0,
        retainedLimit: 256,
        offset: 0,
        receipts: [],
      }),
      readRuntimeSubagentCommand: vi.fn().mockResolvedValue({ receiptEpoch: 2 }),
      steerRuntimeSubagent: vi.fn().mockResolvedValue({
        accepted: true,
        queued: true,
        status: 'queued_live',
        agentId: 'agent-5',
        clientMessageId: 'cmd:2:test',
      }),
      readSubagentArtifact: vi.fn().mockResolvedValue({
        content: 'safe history',
        offset: 0,
        nextOffset: 65536,
        size: 100000,
        revision: 'public-revision',
        truncated: true,
      }),
      readRuntimeSubagentLive: vi.fn().mockResolvedValue({
        active: true,
        unchanged: false,
        revision: 7,
        content: 'public tokens',
        truncated: false,
      }),
      archiveRuntimeSubagentCommands: vi.fn().mockResolvedValue({ receiptEpoch: 3 }),
      stopRuntimeSubagent: vi
        .fn()
        .mockResolvedValue({ stopped: true, status: 'stopped', expectedBackgroundRun: run }),
    }
    const hook = renderHook(
      ({ taskAddress, activity }) =>
        useSubagentWorkspaceHost(
          api as unknown as ReturnType<typeof createRuntimeWorkApi>,
          taskAddress,
          activity,
          'Parent'
        ),
      { initialProps: { taskAddress: address, activity: [] as RuntimeSubagentStatus[] } }
    )
    async function open() {
      await waitFor(() => expect(hook.result.current.statuses).toHaveLength(6))
      act(() => hook.result.current.openAgent('agent-5'))
      await waitFor(() => expect(hook.result.current.workspace?.canSteer).toBe(receipts))
      return hook.result.current.workspace!
    }
    return { ...hook, api, list, open, streams, unsubscribe }
  }
  test('opens all discovered identities and stops only the actual background run', async () => {
    const hook = setup()
    const workspace = await hook.open()
    expect(workspace.canStop).toBe(true)
    await workspace.onStop!('agent-5')
    expect(hook.api.stopRuntimeSubagent).toHaveBeenCalledWith({
      address,
      agentId: 'agent-5',
      expectedBackgroundRun: run,
    })
    act(() => hook.result.current.openAgent('agent-0'))
    await waitFor(() => expect(hook.result.current.workspace?.agent.agentId).toBe('agent-0'))
    expect(hook.result.current.workspace?.canStop).toBe(false)
  })

  test('a confirmed stop survives same-scope address reconstruction and parent metadata rerender', async () => {
    const hook = setup()
    const workspace = await hook.open()
    let complete: (value: {
      stopped: boolean
      status: string
      expectedBackgroundRun: typeof run
    }) => void = () => {}
    hook.api.stopRuntimeSubagent.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    let stop: Promise<{ stopped: boolean; status: string; reasonCode?: string }>
    act(() => {
      stop = workspace.onStop!('agent-5')
    })
    const refreshedAddress = { ...address, runtimeHandle: { metadataVersion: 2 } }
    hook.rerender({
      taskAddress: refreshedAddress,
      activity: [
        {
          id: 'agent-5',
          agentId: 'agent-5',
          agentPath: 'agent-5',
          agentName: 'worker',
          status: 'interrupted',
        },
      ],
    })
    expect(hook.result.current.workspace?.agent.agentId).toBe('agent-5')
    await act(async () => {
      complete({ stopped: true, status: 'stopped', expectedBackgroundRun: run })
      await expect(stop!).resolves.toMatchObject({ stopped: true, status: 'stopped' })
    })
    expect(hook.api.stopRuntimeSubagent).toHaveBeenCalledTimes(1)
    expect(hook.api.listRuntimeSubagents).toHaveBeenLastCalledWith({ address: refreshedAddress })
  })

  test.each([
    { name: 'target', next: { ...address, deviceId: 'different-target' } },
    { name: 'thread', next: { ...address, threadId: 'different-thread' } },
  ])('a pending stop is rejected when the actual $name identity changes', async ({ next }) => {
    const hook = setup()
    const workspace = await hook.open()
    let complete: (value: {
      stopped: boolean
      status: string
      expectedBackgroundRun: typeof run
    }) => void = () => {}
    hook.api.stopRuntimeSubagent.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    let stop: Promise<{ stopped: boolean; status: string; reasonCode?: string }>
    act(() => {
      stop = workspace.onStop!('agent-5')
    })
    hook.rerender({ taskAddress: next, activity: [] })
    const rejected = expect(stop!).rejects.toThrow('target changed')
    await act(async () => {
      complete({ stopped: true, status: 'stopped', expectedBackgroundRun: run })
      await rejected
    })
  })

  test.each(['account', 'authority'])(
    'a pending stop cannot report into another %s',
    async change => {
      const hook = setup()
      const workspace = await hook.open()
      let complete: (value: {
        stopped: boolean
        status: string
        expectedBackgroundRun: typeof run
      }) => void = () => {}
      hook.api.stopRuntimeSubagent.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            complete = resolve
          })
      )
      let stop: Promise<{ stopped: boolean; status: string; reasonCode?: string }>
      act(() => {
        stop = workspace.onStop!('agent-5')
      })
      if (change === 'account') act(() => notifyAccountContextChange('target-1'))
      else {
        hook.list.journalScope = 'different-principal-authority'
        act(() => hook.result.current.openAgent('agent-5'))
        await waitFor(() => expect(hook.result.current.workspace).toBeNull())
      }
      const rejected = expect(stop!).rejects.toThrow('target changed')
      await act(async () => {
        complete({ stopped: true, status: 'stopped', expectedBackgroundRun: run })
        await rejected
      })
      expect(hook.result.current.workspace).toBeNull()
    }
  )
  test('actual task goal identifies workers when their event name is only a generic tool', async () => {
    const hook = setup()
    hook.list.agents[5].presentation!.goal = 'Distinct task title\nMore instructions'
    await hook.open()
    expect(hook.result.current.workspace?.agent.agentName).toBe('Distinct task title')
  })
  test('failed authority status cannot be displayed as successful completion', async () => {
    const hook = setup()
    await hook.open()
    hook.list.agents[5].status = 'failed'
    act(() => hook.result.current.openAgent('agent-5'))
    await waitFor(() => expect(hook.result.current.workspace?.agent.status).toBe('interrupted'))
  })
  test('older receipt capability remains read only and never sends recovery IDs', async () => {
    const hook = setup(false, false, false)
    const workspace = await hook.open()
    expect(workspace.canSteer).toBe(false)
    expect(workspace.canStop).toBe(false)
    expect(hook.api.listRuntimeSubagentCommands).not.toHaveBeenCalled()
    expect(hook.api.steerRuntimeSubagent).not.toHaveBeenCalled()
  })
  test('recovering a pending client ID performs exact lookup and never resends', async () => {
    const recovery = new SubagentCommandJournal(
      localStorage,
      'principal-target-thread:["agent-5","worker-5"]'
    )
    recovery.remember({
      clientMessageId: 'cmd:2:pending',
      message: 'private command body',
      status: 'unknown',
    })
    const hook = setup()
    await hook.open()
    await waitFor(() =>
      expect(hook.api.readRuntimeSubagentCommand).toHaveBeenCalledWith({
        address,
        agentId: 'agent-5',
        clientMessageId: 'cmd:2:pending',
      })
    )
    expect(hook.result.current.workspace?.commandHistory).toMatchObject([
      { clientMessageId: 'cmd:2:pending', status: 'unknown', message: '' },
    ])
    expect(hook.api.steerRuntimeSubagent).not.toHaveBeenCalled()
    expect(JSON.stringify(localStorage)).not.toContain('private command body')
  })
  test('account invalidation closes Workspace and rejects stale mutation callbacks', async () => {
    const hook = setup()
    const workspace = await hook.open()
    act(() => notifyAccountContextChange('target-1'))
    await waitFor(() => expect(hook.result.current.workspace).toBeNull())
    await expect(workspace.onSteer('agent-5', 'late command', 'cmd:2:late')).rejects.toThrow(
      'account or target changed'
    )
    expect(hook.api.steerRuntimeSubagent).not.toHaveBeenCalled()
  })
  test('closing and reopening the same actual agent preserves its draft without sending', async () => {
    const hook = setup()
    const workspace = await hook.open()
    act(() => workspace.onDraftChange!('unsent child command'))
    act(() => hook.result.current.workspace!.onClose())
    expect(hook.result.current.workspace).toBeNull()
    act(() => hook.result.current.openAgent('agent-5'))
    await waitFor(() => expect(hook.result.current.workspace?.draft).toBe('unsent child command'))
    expect(hook.api.steerRuntimeSubagent).not.toHaveBeenCalled()
  })
  test('confirmed archive epoch cannot regress to an overlapping stale history read', async () => {
    const hook = setup()
    const workspace = await hook.open()
    await act(async () => {
      await workspace.onArchiveCommands!([], 2)
    })
    expect(hook.api.archiveRuntimeSubagentCommands).toHaveBeenCalledWith({
      address,
      agentId: 'agent-5',
      expectedEpoch: 2,
      confirmedMessageIds: [],
    })
    expect(hook.result.current.workspace?.commandEpoch).toBe(3)
  })
  test('unconfirmed archive response preserves local recovery handles', async () => {
    const recovery = new SubagentCommandJournal(
      localStorage,
      'principal-target-thread:["agent-5","worker-5"]'
    )
    recovery.remember({ clientMessageId: 'cmd:2:pending', message: 'command', status: 'unknown' })
    const hook = setup()
    const workspace = await hook.open()
    hook.api.archiveRuntimeSubagentCommands.mockResolvedValue({ receiptEpoch: 2 })
    await expect(workspace.onArchiveCommands!([], 2)).rejects.toThrow('epoch is unconfirmed')
    expect(recovery.load()).toMatchObject([{ clientMessageId: 'cmd:2:pending' }])
  })
  test('only exact source agent and actual run can populate shared interaction UI', async () => {
    const hook = setup()
    await hook.open()
    expect(hook.result.current.sourceMatches(undefined)).toBe(false)
    expect(
      hook.result.current.sourceMatches({
        parentSessionId: 'parent',
        agentId: 'agent-5',
        backgroundRun: run,
      })
    ).toBe(true)
    expect(
      hook.result.current.sourceMatches({
        parentSessionId: 'parent',
        agentId: 'agent-5',
        backgroundRun: { ...run, runId: 'old-run' },
      })
    ).toBe(false)
    expect(
      hook.result.current.sourceMatches({ parentSessionId: 'parent', agentId: 'agent-5' })
    ).toBe(false)
    expect(
      hook.result.current.sourceMatches({
        parentSessionId: 'other-parent',
        agentId: 'agent-5',
        backgroundRun: run,
      })
    ).toBe(false)
  })
  test('historical pages carry file CAS and the host never polls the old live text endpoint', async () => {
    const hook = setup()
    const workspace = await hook.open()
    expect((await workspace.onReadLatest!('agent-5', 'transcript')).content).toBe('safe history')
    hook.api.readRuntimeSubagentLive.mockResolvedValue({
      active: true,
      unchanged: true,
      revision: 7,
      content: '',
      truncated: false,
    })
    expect((await workspace.onReadLatest!('agent-5', 'transcript')).content).toBe('safe history')
    expect(hook.api.readRuntimeSubagentLive).not.toHaveBeenCalled()
    await workspace.onReadArtifact('agent-5', 'transcript', 0)
    await workspace.onReadArtifact('agent-5', 'transcript', 65536)
    expect(hook.api.readSubagentArtifact).toHaveBeenLastCalledWith({
      address,
      agentId: 'agent-5',
      kind: 'transcript',
      offset: 65536,
      limit: 65536,
      revision: 'public-revision',
    })
  })

  test('host projects push increments and releases the observation when returning to parent', async () => {
    const hook = setup()
    await hook.open()
    await waitFor(() =>
      expect(hook.api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(1)
    )
    act(() =>
      hook.streams.get('agent-5')!({
        type: 'event',
        threadId: 'parent',
        agentId: 'agent-5',
        subscriptionId: 'agent-5',
        runId: 'actual-run',
        sequence: 1,
        method: 'item/delta',
        params: {},
        actions: [{ type: 'assistant_chunk', subtaskId: 'assistant', content: 'incremental body' }],
      })
    )
    expect(hook.result.current.workspace?.conversationMessages?.[0].content).toBe(
      'incremental body'
    )
    expect(hook.result.current.workspace?.conversationActive).toBe(true)
    act(() => hook.result.current.workspace!.onClose())
    expect(hook.unsubscribe).toHaveBeenCalledTimes(1)
    expect(hook.api.stopRuntimeSubagent).not.toHaveBeenCalled()
    expect(hook.api.readRuntimeSubagentLive).not.toHaveBeenCalled()
    expect(hook.api.readSubagentArtifact).not.toHaveBeenCalled()
  })

  test('continuing a finished worker resubscribes to its authoritative new run without closing or losing draft/history', async () => {
    const hook = setup()
    await hook.open()
    await waitFor(() =>
      expect(hook.api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(1)
    )
    const first = hook.streams.get('agent-5')!
    act(() =>
      first({
        type: 'event',
        threadId: 'parent',
        agentId: 'agent-5',
        subscriptionId: 'agent-5',
        runId: 'actual-run',
        sequence: 1,
        method: 'item/delta',
        params: {},
        actions: [{ type: 'assistant_chunk', subtaskId: 'assistant', content: 'finished history' }],
      })
    )
    act(() =>
      first({
        type: 'event',
        threadId: 'parent',
        agentId: 'agent-5',
        subscriptionId: 'agent-5',
        runId: 'actual-run',
        sequence: 2,
        method: 'item/event',
        params: {},
        terminalStatus: 'completed',
        actions: [{ type: 'assistant_done', subtaskId: 'assistant' }],
      })
    )
    const history = hook.result.current.workspace!.conversationMessages!
    act(() => hook.result.current.workspace!.onDraftChange!('another unsent draft'))
    let complete: (value: RuntimeSubagentConversationSubscription) => void = () => {}
    hook.api.subscribeRuntimeSubagentConversation.mockImplementationOnce((params, handler) => {
      hook.streams.set(params.agentId, handler)
      return new Promise(resolve => {
        complete = resolve
      })
    })
    hook.api.steerRuntimeSubagent.mockImplementationOnce(async () => {
      hook.list.agents[5].backgroundRun = { ...run, runId: 'continued-run' }
      return {
        accepted: true,
        queued: true,
        status: 'resuming',
        agentId: 'agent-5',
        clientMessageId: 'cmd:2:continue',
      }
    })
    await act(async () => {
      await hook.result.current.workspace!.onSteer('agent-5', 'resume now', 'cmd:2:continue')
    })
    await waitFor(() =>
      expect(hook.api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2)
    )
    expect(hook.result.current.workspace?.draft).toBe('another unsent draft')
    expect(hook.result.current.workspace?.conversationMessages?.[0].content).toBe(
      'finished history'
    )
    expect(hook.result.current.workspace?.conversationLoading).toBe(true)
    expect(hook.unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () =>
      complete({
        snapshot: {
          threadId: 'parent',
          agentId: 'agent-5',
          subscriptionId: 'continued-sub',
          runId: 'continued-run',
          sequence: 0,
          active: true,
          messages: history,
        },
        unsubscribe: hook.unsubscribe,
      })
    )
    act(() =>
      hook.streams.get('agent-5')!({
        type: 'event',
        threadId: 'parent',
        agentId: 'agent-5',
        subscriptionId: 'continued-sub',
        runId: 'continued-run',
        sequence: 1,
        method: 'item/delta',
        params: {},
        actions: [
          {
            type: 'assistant_chunk',
            subtaskId: 'continued-assistant',
            content: 'S03_ADJUST_AFTER_COMPLETE',
          },
        ],
      })
    )
    expect(hook.result.current.workspace?.conversationMessages?.[1].content).toBe(
      'S03_ADJUST_AFTER_COMPLETE'
    )
    expect(hook.result.current.workspace?.conversationActive).toBe(true)
    expect(hook.api.readSubagentArtifact).not.toHaveBeenCalled()
    expect(hook.api.readRuntimeSubagentLive).not.toHaveBeenCalled()
  })
})

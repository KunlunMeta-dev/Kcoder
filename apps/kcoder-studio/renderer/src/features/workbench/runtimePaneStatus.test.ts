import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { RuntimeTaskMachine } from './runtimeTaskLifecycle/RuntimeTaskMachine'
import { deriveRuntimePaneStatus } from './runtimePaneStatus'

const runtimeAddress: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project',
  taskId: 'runtime-a',
}

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: runtimeAddress.taskId,
    workspacePath: runtimeAddress.workspacePath ?? '',
    title: 'Runtime A',
    runtime: 'codex',
    running: false,
    continuable: true,
    ...overrides,
  }
}

function assistantMessage(status: WorkbenchMessage['status']): WorkbenchMessage {
  return {
    id: 'runtime-a:message:1',
    role: 'assistant',
    content: 'working',
    status,
    createdAt: '2026-07-02T00:00:00.000Z',
    subtaskId: 1,
  }
}

function statusFor(machine: RuntimeTaskMachine, messages: WorkbenchMessage[] = []) {
  return deriveRuntimePaneStatus({
    messages,
    currentRuntimeTask: runtimeAddress,
    lifecycle: machine.getSnapshot(),
  })
}

describe('runtime pane status from task lifecycle machine', () => {
  test('uses the machine execution snapshot as the only busy source', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: true }),
    })

    const status = statusFor(machine)

    expect(status.taskExecution.running).toBe(true)
    expect(status.isBusy).toBe(true)
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
  })

  test('shows submitting immediately from the optimistic machine event', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'send_requested' })

    const status = statusFor(machine)

    expect(status.isSubmitting).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.taskExecution.running).toBe(true)
  })

  test('shows waiting after executor accepts the send', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'send_requested' })
    machine.dispatch({ type: 'send_accepted' })

    const status = statusFor(machine, [assistantMessage('failed')])

    expect(status.isAwaitingAssistant).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isBusy).toBe(true)
  })

  test('shows streaming only when the machine owns an active turn', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })

    const status = statusFor(machine, [assistantMessage('streaming')])

    expect(status.isAssistantStreaming).toBe(true)
    expect(status.activeAssistantMessage?.id).toBe('runtime-a:message:1')
    expect(status.isWaitingForAssistantIndicator).toBe(false)
  })

  test('ignores a stale streaming message after the machine settles the turn', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, status: 'done' }),
    })

    const status = statusFor(machine, [assistantMessage('streaming')])

    expect(status.activeAssistantMessage).toBeNull()
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isBusy).toBe(false)
  })

  test('keeps an active Goal visibly running between turns', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: true, status: 'active', goalStatus: 'active' }),
    })
    machine.dispatch({ type: 'turn_started' })
    machine.dispatch({ type: 'turn_settled' })

    const status = statusFor(machine, [assistantMessage('done')])

    expect(status.taskExecution.running).toBe(true)
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isBusy).toBe(true)
    expect(status.canSendQueuedMessage).toBe(false)
  })

  test('does not infer running from a persisted active Goal after restart', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, status: 'active', goalStatus: 'active' }),
    })

    const status = statusFor(machine, [assistantMessage('done')])

    expect(status.taskExecution.running).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(false)
    expect(status.isBusy).toBe(false)
    expect(status.canSendQueuedMessage).toBe(true)
  })

  test('keeps continuation capability separate from execution', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, continuable: false, status: 'done' }),
    })

    const status = statusFor(machine)

    expect(status.taskExecution.running).toBe(false)
    expect(status.taskExecution.continuable).toBe(false)
    expect(status.canSendQueuedMessage).toBe(false)
  })
})

function toolBlockMessage(toolName: string, toolStatus: string): WorkbenchMessage {
  return {
    ...assistantMessage('streaming'),
    blocks: [{ id: `tool-${toolName}`, type: 'tool', toolName, status: toolStatus }],
  }
}

describe('shortenable tool detection for the stop button', () => {
  test('flags a running Sleep or wait tool', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })
    for (const name of ['Sleep', 'wait']) {
      const status = statusFor(machine, [toolBlockMessage(name, 'running')])
      expect(status.hasRunningShortenableTool).toBe(true)
    }
  })

  test('clears once the tool is done or failed', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })
    for (const toolStatus of ['done', 'error']) {
      const status = statusFor(machine, [toolBlockMessage('Sleep', toolStatus)])
      expect(status.hasRunningShortenableTool).toBe(false)
    }
  })

  test('tolerates the casing and spacing a runtime reports', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })
    for (const name of ['sleep', 'Wait', '  SLEEP  ']) {
      const status = statusFor(machine, [toolBlockMessage(name, 'running')])
      expect(status.hasRunningShortenableTool).toBe(true)
    }
    for (const name of ['SleepTool', 'bash', 'Bash(sleep 30)']) {
      const status = statusFor(machine, [toolBlockMessage(name, 'running')])
      expect(status.hasRunningShortenableTool).toBe(false)
    }
  })

  test('ignores a wait block left behind in an earlier message', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })
    const stale = {
      ...toolBlockMessage('Sleep', 'running'),
      id: 'runtime-a:message:0',
      status: 'done' as const,
    }
    const active = toolBlockMessage('bash', 'running')
    const status = statusFor(machine, [stale, active])
    expect(status.hasRunningShortenableTool).toBe(false)
  })

  test('ignores a wait block once its turn is no longer streaming', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    const finished = {
      ...toolBlockMessage('Sleep', 'running'),
      status: 'done' as const,
    }
    const status = statusFor(machine, [finished])
    expect(status.hasRunningShortenableTool).toBe(false)
  })

  test('ignores other running tools', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })
    const status = statusFor(machine, [toolBlockMessage('bash', 'running')])
    expect(status.hasRunningShortenableTool).toBe(false)
  })
})

import type { RuntimeTaskAddress } from '@/types/api'
import { reduceRuntimeTaskLifecycle } from './reducer'
import type {
  RuntimeTaskLifecycleEvent,
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleState,
} from './types'

export class RuntimeTaskMachine {
  private state: RuntimeTaskLifecycleState
  private snapshot: RuntimeTaskLifecycleSnapshot | null = null

  constructor(address: RuntimeTaskAddress, unread = false) {
    this.state = {
      address,
      task: null,
      executionPhase: 'unknown',
      turnPhase: 'idle',
      activeTurnId: null,
      activeBackgroundAgents: new Set(),
      goalStatus: null,
      continuable: false,
      unread,
      expectedExecutorRunning: null,
      expectedActivityWatermark: null,
    }
  }

  dispatch(event: RuntimeTaskLifecycleEvent): boolean {
    const previous = this.state
    this.state = reduceRuntimeTaskLifecycle(previous, event)
    if (this.state !== previous) this.snapshot = null
    return this.state !== previous
  }

  getState(): RuntimeTaskLifecycleState {
    return this.state
  }

  getSnapshot(): RuntimeTaskLifecycleSnapshot {
    if (this.snapshot) return this.snapshot
    const { address, task, executionPhase, turnPhase, goalStatus, continuable, unread } = this.state
    const visibleExecutionPhase =
      this.state.activeBackgroundAgents.size > 0 &&
      (executionPhase === 'unknown' || executionPhase === 'idle')
        ? 'running'
        : executionPhase
    const executionKnown = visibleExecutionPhase !== 'unknown'
    const isRunning =
      executionPhase === 'starting' ||
      executionPhase === 'running' ||
      executionPhase === 'stopping' ||
      this.state.activeBackgroundAgents.size > 0
    const isTurnActive = turnPhase !== 'idle'
    const isThinking = turnPhase === 'submitting' || turnPhase === 'awaiting'
    const isBusy = isRunning || isTurnActive

    this.snapshot = {
      key: getRuntimeTaskLifecycleKey(address),
      address,
      task,
      execution: {
        phase: visibleExecutionPhase,
        known: executionKnown,
        running: isRunning,
      },
      turn: {
        phase: turnPhase,
        active: isTurnActive,
      },
      goalStatus,
      continuable,
      unread,
      derived: {
        executionKnown,
        isRunning,
        isTurnActive,
        isThinking,
        isBusy,
        canSend: continuable && !isBusy,
        canQueue: continuable && isBusy,
        shouldShowSidebarRunning: isBusy,
        shouldShowUnread: unread && !isRunning,
      },
    }
    return this.snapshot
  }
}

export function getRuntimeTaskLifecycleKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}

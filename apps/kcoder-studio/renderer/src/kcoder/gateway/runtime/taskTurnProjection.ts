import { threadRunActivity } from '../../threadRunSummary'
import type { GatewayTask } from './contracts'

/** Confirmed turn events retain their outcome without erasing independent background facts. */
export function projectTaskTurn(task: GatewayTask, status: NonNullable<GatewayTask['turnStatus']>, background = false): GatewayTask {
  const running = status === 'inProgress'
  const summary = task.runSummary ? {
    ...task.runSummary,
    mainTurn: running ? 'running' as const : 'idle' as const,
    latestTurnStatus: running ? undefined : status,
  } : undefined
  const activity = threadRunActivity(running ? 'running' : 'idle', summary)
  return {
    ...task,
    running,
    turnStatus: status,
    completedAt: status === 'completed' ? Date.now() : undefined,
    runSummary: summary,
    runActivity: !running && background && activity === 'idle' ? 'background' : activity,
    updatedAt: Date.now(),
  }
}

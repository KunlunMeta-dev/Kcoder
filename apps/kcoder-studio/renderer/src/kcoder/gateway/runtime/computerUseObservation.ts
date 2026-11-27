import {
  isComputerUseTurnStatusResult,
  type ComputerUseTurnStatusParams,
  type ComputerUseTurnStatusResult,
} from '../../../../../shared/generated/contracts'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { computerUseConsent } from '../../computerUseConsent'
import {
  computerUseStates,
  type ComputerUseObservationToken,
} from '../../computerUseState'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayTask } from './contracts'
import type { GatewayRuntimeCore } from './core'

const TURN_STATUS_CAPABILITY = 'computerUseTurnStatusV1'
const TURN_STATUS_METHOD = 'computerUse/turn/status'

/** Read one existing host observation after task resume; never starts or recovers a worker. */
export async function readComputerUseTurnObservation(
  runtime: GatewayRuntimeCore,
  task: GatewayTask,
  client: GatewayClient,
  token: ComputerUseObservationToken,
  assertResumeOwner: () => Promise<void>
): Promise<void> {
  try {
    if (
      token.owner !== runtime ||
      token.serverId !== task.serverId ||
      token.taskId !== task.taskId ||
      client.supportsExperimental?.(TURN_STATUS_CAPABILITY) !== true
    )
      return
    const connectionId = client.diagnosticConnection?.connectionId
    const connectionOwner = connectionId ?? client
    if (
      token.connectionOwner !== connectionOwner ||
      (connectionId !== undefined && !client.requestOnConnection)
    )
      return
    const sameConnection = () => client.diagnosticConnection?.connectionId === connectionId

    const locallyOwned = () => {
      const currentTask = runtime.tasks.get(task.taskId)
      const activeTurnId = runtime.activeTurnByTask.get(task.taskId)?.turnId
      const attemptId = runtime.turnAttemptIds.get(`${task.taskId}:${token.turnId}`)
      return (
        !runtime.disposed &&
        !runtime.isRestartingServer(task.serverId) &&
        sameConnection() &&
        runtime.clientByTask.get(task.taskId) === client &&
        runtime.connectionsByClient.has(client) &&
        !runtime.appServerDisconnectedClients.has(client) &&
        currentTask?.taskId === task.taskId &&
        currentTask.serverId === task.serverId &&
        currentTask.threadId === task.threadId &&
        sameWorkspacePath(currentTask.workspacePath, task.workspacePath) &&
        computerUseStates.isLatestTurn(runtime, task.serverId, task.taskId, token.turnId) &&
        (token.requireActiveTurn
          ? activeTurnId === token.turnId && attemptId === token.attemptId
          : activeTurnId === undefined)
      )
    }
    const current = async () => {
      if (!locallyOwned()) return false
      try {
        await assertResumeOwner()
      } catch {
        return false
      }
      return locallyOwned()
    }

    if (!(await current())) return
    const params: ComputerUseTurnStatusParams = {
      threadId: task.threadId,
      turnId: token.turnId,
    }
    const response = connectionId
      ? await client.requestOnConnection!(connectionId, TURN_STATUS_METHOD, params)
      : await client.request<unknown>(TURN_STATUS_METHOD, params)
    if (!isComputerUseTurnStatusResult(response)) return
    const result: ComputerUseTurnStatusResult = response
    if (
      !(await current()) ||
      result.threadId !== task.threadId ||
      result.turnId !== token.turnId ||
      !Number.isSafeInteger(result.sequence) ||
      result.sequence < 0 ||
      !result.observation
    )
      return

    const observation = result.observation
    const applied = computerUseStates.applyObservation(
      token,
      connectionOwner,
      result.sequence,
      observation as unknown as Record<string, unknown>
    )
    if (
      applied &&
      (observation.diagnostic?.authorization === 'revoked' ||
        observation.diagnostic?.authorization === 'unknown')
    )
      computerUseConsent.set(task.serverId, task.taskId, false)
  } catch {
    return
  } finally {
    computerUseStates.releaseObservation(token)
  }
}

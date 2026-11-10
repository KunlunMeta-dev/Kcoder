import type {
  TaskDeliveryResult,
  TaskDeliveryFailureResult,
} from '../../../shared/generated/contracts'
import { invokeRuntimeCommand } from './gatewayServiceBridge'

export interface TaskDeliveryOwner {
  taskId: string
  threadId: string
  deviceId: string
  /** Includes the runtime target, account/profile revision and original task. */
  scope: string
}

export interface TaskDeliveryApi {
  prepare(baseBranch: string, comparisonId?: string): Promise<TaskDeliveryResult>
  read(deliveryId: string): Promise<TaskDeliveryResult>
  request(deliveryId: string, requestId: string, title: string, body: string): Promise<TaskDeliveryResult>
  failure(deliveryId: string, checkId: string): Promise<TaskDeliveryFailureResult>
}

/** The runtime resolves this original task; callers never submit workspace paths or HEAD claims. */
export function taskDeliveryApi(owner: TaskDeliveryOwner): TaskDeliveryApi {
  const call = <T>(command: string, params: Record<string, unknown>) =>
    invokeRuntimeCommand<T>('local_executor_request', {
      method: 'runtime.taskDelivery.request',
      params: { taskId: owner.taskId, threadId: owner.threadId, deviceId: owner.deviceId, method: command, ...params },
    })
  return {
    prepare: (baseBranch, comparisonId) =>
      call('task/delivery/prepare', { baseBranch, ...(comparisonId ? { comparisonId } : {}) }),
    read: deliveryId => call('task/delivery/read', { deliveryId }),
    request: (deliveryId, requestId, title, body) =>
      call('task/delivery/request', { deliveryId, requestId, title, body }),
    failure: (deliveryId, checkId) => call('task/delivery/failure', { deliveryId, checkId }),
  }
}

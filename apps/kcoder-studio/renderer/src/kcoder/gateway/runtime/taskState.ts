import { TaskStateEventConsumer } from '../../taskStateEvents'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { EXECUTOR_EVENT } from './contracts'
import type { GatewayRuntimeCore } from './core'

const consumers = new WeakMap<GatewayClient, TaskStateEventConsumer>()

export async function forwardTaskState(core: GatewayRuntimeCore, serverId: string, client: GatewayClient, payload: unknown) {
  if (client.supportsExperimental?.('integrationTaskStateV1') !== true) return
  let consumer = consumers.get(client)
  if (!consumer) {
    const epoch = core.accountEpochByTarget.get(serverId)
    const connectionId = client.diagnosticConnection?.connectionId
    const current = () => !core.disposed && core.accountEpochByTarget.get(serverId) === epoch
      && client.diagnosticConnection?.connectionId === connectionId
    consumer = new TaskStateEventConsumer((method, params, options) => client.request(method, params, options), current)
    consumers.set(client, consumer)
    client.addEventListener('close', () => { consumer?.dispose(); consumers.delete(client) }, { once: true })
  }
  const observation = await consumer.accept(payload)
  if (observation) await emitRuntimeEvent(EXECUTOR_EVENT, {
    event: 'response.integration.task_state', payload: { deviceId: serverId, observation },
  })
}

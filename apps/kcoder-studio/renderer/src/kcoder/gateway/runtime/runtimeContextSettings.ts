import { GatewayRpcError } from '../../gatewayRpc'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { clearLegacyKCoderContext } from '../../gatewayRuntimeSettings'
import type { GatewayRuntimeCore } from './core'
import type { SharedRuntimeContext } from './contracts'

/** One owner across explicit target discovery, command connection and context-setting results. */
export async function requestRuntimeContextSettings(runtime: GatewayRuntimeCore, params: Record<string, unknown>, field: 'instructions' | 'personality', write: boolean) {
  const generation = runtime.workspaceScanGeneration
  if (runtime.restartingAppServers) await runtime.assertRequestTargetAvailable(params)
  const instructions = typeof params.instructions === 'string' ? params.instructions : ''
  if (write && field === 'personality' && params.personality !== 'friendly' && params.personality !== 'pragmatic')
    throw new Error('不支持的 KCoder 个性')
  if (write && field === 'instructions' && instructions.length > 64 * 1024) throw new Error('自定义指令超过 64 KiB 限制')
  const target = await runtime.serverForParams(params)
  const assertScope = () => {
    if (runtime.disposed || generation !== runtime.workspaceScanGeneration ||
        params.targetScope !== undefined && params.targetScope !== hookTargetScope(target))
      throw new GatewayRpcError('Context settings target or account changed', -32049, { kind: `${field}_scope_changed` })
  }
  assertScope()
  const client = await runtime.commandClient(target)
  assertScope()
  let context: SharedRuntimeContext
  if (write) {
    runtime.runtimeContextReads.delete(client)
    try {
      context = await client.request<SharedRuntimeContext>('runtime.context.update', { [field]: field === 'instructions' ? instructions : params.personality })
    } finally {
      runtime.runtimeContextReads.delete(client)
    }
  } else {
    context = await runtime.sharedRuntimeContext(client)
  }
  assertScope()
  if (write) clearLegacyKCoderContext()
  return field === 'instructions'
    ? { instructions: context.instructions, configPath: context.configPath }
    : { personality: context.personality }
}

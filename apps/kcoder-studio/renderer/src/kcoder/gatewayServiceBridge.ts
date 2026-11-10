/* Runtime integration shared by the Web and Electron renderer. */
import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
export { registerRuntimeTransport as registerGatewayCommandTransport } from '@/lib/runtime-transport'
export { invoke as invokeRuntimeCommand } from '@/lib/runtime-commands'
export {
  listen as subscribeRuntimeEvent,
  emit as emitRuntimeEvent,
} from '@/lib/runtime-events'

export interface GatewayWorkspaceSessionRuntime {
  startTerminal(deviceId: string, cwd?: string): Promise<DeviceSessionResponse>
  restoreTerminal(
    deviceId: string,
    cwd: string | undefined,
    sessionId: string
  ): Promise<DeviceSessionResponse>
  createTerminalClient(sessionId: string): RemoteTerminalClient
}

let activeRuntime: GatewayWorkspaceSessionRuntime | null = null

export function registerGatewayWorkspaceSessionRuntime(
  runtime: GatewayWorkspaceSessionRuntime
): () => void {
  activeRuntime = runtime
  return () => {
    if (activeRuntime === runtime) activeRuntime = null
  }
}

export function startGatewayTerminal(
  deviceId: string,
  cwd?: string
): Promise<DeviceSessionResponse> {
  if (!activeRuntime) return Promise.reject(new Error('KCoder 网关终端运行时尚未初始化'))
  return activeRuntime.startTerminal(deviceId, cwd)
}

export function restoreGatewayTerminal(
  deviceId: string,
  cwd: string | undefined,
  sessionId: string
): Promise<DeviceSessionResponse> {
  if (!activeRuntime) return Promise.reject(new Error('KCoder 网关终端运行时尚未初始化'))
  return activeRuntime.restoreTerminal(deviceId, cwd, sessionId)
}

export function createGatewayTerminalClient(sessionId: string): RemoteTerminalClient {
  if (!activeRuntime) throw new Error('KCoder 网关终端运行时尚未初始化')
  return activeRuntime.createTerminalClient(sessionId)
}

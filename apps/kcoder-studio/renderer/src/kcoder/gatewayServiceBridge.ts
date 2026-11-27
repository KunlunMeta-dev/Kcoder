/* Runtime integration shared by the Web and Electron renderer. */
import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import type { TerminalKcoderTui } from '../../../shared/generated/contracts'
export { registerRuntimeTransport as registerGatewayCommandTransport } from '@/lib/runtime-transport'
export { invoke as invokeRuntimeCommand } from '@/lib/runtime-commands'
export {
  listen as subscribeRuntimeEvent,
  emit as emitRuntimeEvent,
} from '@/lib/runtime-events'

export interface GatewayWorkspaceSessionRuntime {
  startTerminal(deviceId: string, cwd?: string, tui?: KcoderTuiStartOptions): Promise<DeviceSessionResponse>
  restoreTerminal(
    deviceId: string,
    cwd: string | undefined,
    sessionId: string
  ): Promise<DeviceSessionResponse>
  createTerminalClient(sessionId: string): RemoteTerminalClient
}

export interface KcoderTuiStartOptions {
  request: TerminalKcoderTui
  isCurrent: () => boolean
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

export async function startGatewayKcoderTui(
  deviceId: string,
  cwd: string,
  options: KcoderTuiStartOptions
) {
  const runtime = activeRuntime
  if (!runtime) throw new Error('TERMINAL_KCODER_TUI_UNSUPPORTED')
  const session = await runtime.startTerminal(deviceId, cwd, {
    request: options.request,
    isCurrent: () => activeRuntime === runtime && options.isCurrent(),
  })
  return { session, clientFactory: runtime.createTerminalClient.bind(runtime) }
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

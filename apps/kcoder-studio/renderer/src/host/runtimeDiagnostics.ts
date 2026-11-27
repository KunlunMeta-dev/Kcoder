import { desktopHost } from '@/kcoder/desktopHost'
import type { LocalExecutorLog, LocalExecutorStatus } from './localExecutor'

export async function readGatewayRuntimeLog(getStatus: () => Promise<LocalExecutorStatus>): Promise<LocalExecutorLog> {
  const host = desktopHost()
  if (!host?.readFeedbackDiagnostics) throw new Error('Runtime logs are unavailable in this browser')
  const diagnostics = await host.readFeedbackDiagnostics({ runtimeLogs: true, systemInfo: false })
  if (desktopHost() !== host) throw new Error('Desktop diagnostics owner changed')
  if (typeof diagnostics.runtimeLogs !== 'string') throw new Error('This host does not provide Gateway logs')
  let status: LocalExecutorStatus
  try { status = await getStatus() }
  catch (error) { status = { running: false, error: error instanceof Error ? error.message : String(error) } }
  if (desktopHost() !== host) throw new Error('Desktop diagnostics owner changed')
  return {
    path: '', content: diagnostics.runtimeLogs, truncated: false,
    lineCount: diagnostics.runtimeLogs ? diagnostics.runtimeLogs.split('\n').length : 0,
    transport: 'stdio', transportConnected: status.running === true && status.ready === true,
    processPids: [], processPaths: [], sidecarSource: 'desktop-gateway', sidecarPath: '',
    currentDir: '', executorHome: '', backendUrl: null, hasBackendAuthToken: false,
    pendingRequestCount: 0, status,
  }
}

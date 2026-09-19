import { requestLocalExecutor } from '@/tauri/localExecutor'

/** One labeled slice of the KCoder configuration directory. */
export interface StorageBucket {
  id: string
  bytes: number
  files: number
  cleanable: boolean
}

export interface DevDebugStatus {
  enabled: boolean
  envSet: boolean
  dotenvLines: number
  retentionDays: number
  logBytes: number
  logFiles: number
  oldestDay?: string
}

export interface CredentialsStatus {
  path: string
  present: boolean
  userOnly?: boolean
  providers: number
  dotenvCredentialLines: number
  /** Whether the operating-system credential store is reachable on this target. */
  keyringAvailable: boolean
  /** Human-readable name of that store. */
  keyringBackend: string
  /** Providers whose secret already lives in the operating-system store. */
  keyringProviders: string[]
  /** Providers still stored as plaintext in credentials.json. */
  plaintextProviders: string[]
}

export interface StorageReport {
  configRoot: string
  totalBytes: number
  totalFiles: number
  buckets: StorageBucket[]
  devDebug: DevDebugStatus
  credentials: CredentialsStatus
}

export interface StorageCleanResult {
  removedBytes: number
  removedFiles: number
  report: StorageReport
}

export interface DebugLogDisableResult {
  changed: boolean
  dotenvPath: string
  note: string
}

export function readStorageReport(serverId: string) {
  return requestLocalExecutor<StorageReport>('runtime.diagnostics.request', {
    serverId,
    method: 'diagnostics/storage/read',
    params: {},
  })
}

export function cleanStorage(serverId: string, target: string) {
  return requestLocalExecutor<StorageCleanResult>('runtime.diagnostics.request', {
    serverId,
    method: 'diagnostics/storage/clean',
    params: { target, confirm: true },
  })
}

export function disableDebugLog(serverId: string) {
  return requestLocalExecutor<DebugLogDisableResult>('runtime.diagnostics.request', {
    serverId,
    method: 'diagnostics/debug-log/disable',
    params: {},
  })
}

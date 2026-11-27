export type StorageLayout = 'legacy' | 'unified' | 'custom'

export type StorageLocationSource =
  | 'default'
  | 'selection'
  | 'configOverride'
  | 'homeOverride'
  | 'cacheOverride'
  | 'dataOverride'
  | 'serversStoreOverride'
  | 'desktopOverride'
  | 'development'

export interface StorageLocationRecord {
  version: number
  revision: number
  dataRoot: string
  cacheRoot: string
  operationId?: string | null
}

export interface StoragePathSources {
  dataRoot: StorageLocationSource
  cacheRoot: StorageLocationSource
  gatewayRoot: StorageLocationSource
  desktopRoot: StorageLocationSource
}

export interface StoragePaths {
  dataRoot: string
  cacheRoot: string
  gatewayRoot: string
  desktopRoot: string
  temporaryRoot: string
  locationFile?: string | null
  layout: StorageLayout
  sources: StoragePathSources
  externallyConfigured: boolean
  selectionRevision?: number | null
  operationId?: string | null
}

export type StorageMigrationPhase =
  | 'planned'
  | 'stopping'
  | 'stopped'
  | 'copying'
  | 'verifying'
  | 'prepared'
  | 'committed'
  | 'verified'

export type StorageMigrationDisposition = 'active' | 'deferred' | 'complete'

export interface StorageMigrationComponent {
  domain: string
  source: string
  destination: string
  sourceIdentity: string
  estimatedBytes: number
}

export interface StorageMigrationPlan {
  version: number
  operationId: string
  original?: StorageLocationRecord | null
  from: StoragePaths
  target: StorageLocationRecord
  components: StorageMigrationComponent[]
  targetBindings?: Array<{
    path: string
    existingAncestor: string
    ancestorIdentity: string
  }>
  launchIntent: 'cli' | 'gateway' | 'desktop' | 'verifyOnly'
}

export interface StorageMigrationReceipt {
  plan: StorageMigrationPlan
  phase: StorageMigrationPhase
  disposition: StorageMigrationDisposition
  ownerReceipts?: Record<string, unknown>
  errorCode?: string | null
}

export interface StorageLocationsSnapshot {
  paths: StoragePaths
  readOnly: boolean
  operation: StorageMigrationReceipt | null
}

export type StorageSourceCleanupStatus =
  | 'eligibleFile' | 'eligibleDirectory' | 'retainedRoot' | 'retainedCurrent'
  | 'retainedInPlace' | 'retainedExcluded' | 'retainedUnknown' | 'retainedChanged'
  | 'retainedNotEmpty' | 'retainedUnconfirmed' | 'absent' | 'removed'

export interface StorageSourceCleanupEntry {
  domain: string
  sourceRoot: string
  relativePath: string
  status: StorageSourceCleanupStatus
  sizeBytes: number | null
  observedVersion: string | null
}

export interface StorageSourceCleanupPreview {
  operationId: string
  selection: StorageLocationRecord
  confirmation: string
  pending: boolean
  entries: StorageSourceCleanupEntry[]
}

export interface StorageSourceCleanupResult {
  operationId: string
  confirmation: string
  entries: StorageSourceCleanupEntry[]
}

interface StorageSourceCleanupLegacyReceipt {
  version: 1
  preview: StorageSourceCleanupPreview
  result: StorageSourceCleanupResult | null
}

interface StorageSourceCleanupCompactReceipt {
  version: 2
  preview: Omit<StorageSourceCleanupPreview, 'entries'> & {
    sources: Array<{
      domain: string
      sourceRoot: string
      entries: Array<Omit<StorageSourceCleanupEntry, 'domain' | 'sourceRoot'>>
    }>
  }
  resultStatuses: StorageSourceCleanupStatus[] | null
}

export type StorageSourceCleanupReceipt = StorageSourceCleanupLegacyReceipt | StorageSourceCleanupCompactReceipt

/** Only the same original receipt can settle an uncertain cleanup reply. */
export function sourceCleanupResult(receipt: StorageMigrationReceipt | null,
  original: { operationId: string; confirmation: string }): StorageSourceCleanupResult | null {
  if (receipt?.plan.operationId !== original.operationId || receipt.disposition !== 'complete' ||
    receipt.phase !== 'verified') return null
  const binding = receipt.ownerReceipts?.['source-cleanup'] as StorageSourceCleanupReceipt | undefined
  if (binding?.version === 1) {
    const result = binding.result
    return result?.operationId === original.operationId && result.confirmation === original.confirmation &&
      Array.isArray(result.entries) ? result : null
  }
  if (binding?.version !== 2) return null
  const { preview, resultStatuses } = binding
  if (preview?.operationId !== original.operationId || preview.confirmation !== original.confirmation ||
    preview.pending !== false || !Array.isArray(preview.sources) || !Array.isArray(resultStatuses) ||
    resultStatuses.length > 4096) return null
  const statuses: readonly string[] = ['eligibleFile', 'eligibleDirectory', 'retainedRoot', 'retainedCurrent',
    'retainedInPlace', 'retainedExcluded', 'retainedUnknown', 'retainedChanged', 'retainedNotEmpty',
    'retainedUnconfirmed', 'absent', 'removed']
  const entries: StorageSourceCleanupEntry[] = []
  for (const source of preview.sources) {
    if (typeof source?.domain !== 'string' || typeof source.sourceRoot !== 'string' ||
      !Array.isArray(source.entries) || source.entries.length === 0 ||
      source.entries.length > resultStatuses.length - entries.length) return null
    for (const entry of source.entries) {
      const status = resultStatuses[entries.length]
      if (!entry || typeof entry.relativePath !== 'string' || !statuses.includes(status)) return null
      entries.push({ ...entry, domain: source.domain, sourceRoot: source.sourceRoot, status })
    }
  }
  return entries.length === resultStatuses.length
    ? { operationId: original.operationId, confirmation: original.confirmation, entries } : null
}

export interface StorageLocationsBridge {
  read(): Promise<StorageLocationsSnapshot>
  pick(options: { kind: 'data' | 'cache' }): Promise<string | null>
  preview(options: { dataRoot: string; cacheRoot: string }): Promise<StorageMigrationPlan | null>
  migrate(options: { operationId: string }): Promise<{
    operationId: string
    state: 'ready' | 'cancelled'
  }>
  retry(options: { operationId: string }): Promise<{
    operationId: string
    state: 'ready' | 'cancelled'
  }>
  cleanupPreview(options: { operationId: string }): Promise<StorageSourceCleanupPreview>
  cleanupConfirm(options: { operationId: string; confirmation: string }): Promise<StorageSourceCleanupResult>
  cleanupStatus(options: { operationId: string }): Promise<StorageMigrationReceipt | null>
}

import i18n from '@/i18n'
import type { GatewayClient } from './gatewayRuntimeTypes'

export function assertAutomationCapabilities(
  client: GatewayClient,
  method: string,
  fields: Record<string, unknown>
): void {
  if (client.supportsExperimental?.('projectAutomations') !== true)
    throw new Error(i18n.t('automations.targetUnsupported'))
  if (method === 'cron/preview' && client.supportsExperimental?.('cronPreviewV1') !== true)
    throw new Error(i18n.t('automations.previewUnsupported'))
  const schedule = fields.schedule
  if (
    method === 'cron/create' &&
    schedule &&
    typeof schedule === 'object' &&
    'kind' in schedule &&
    schedule.kind === 'zoned_cron' &&
    client.supportsExperimental?.('cronTimezoneV1') !== true
  )
    throw new Error(i18n.t('automations.timezoneUnsupported'))
}

/** Rebuildable UI projection. A delivery receipt alone never confirms execution. */
export type AutomationExecutionStatus =
  | 'waiting'
  | 'creating_thread'
  | 'starting_turn'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'coalesced'
  | 'expired'
  | 'unknown'

export interface AutomationExecution {
  triggerId: string
  jobId: string
  title?: string
  scheduledAt: string
  recordedAt: string
  coalesced?: number
  status: AutomationExecutionStatus
  lastRecordedStatus?: string
  workspacePath?: string | null
  threadId?: string | null
  turnId?: string | null
  attemptId?: string | null
  model?: string | null
  timezone?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  replyPreview?: string | null
  error?: string | null
  failureStage?: string | null
  mergedIntoTriggerId?: string | null
  automaticReplay: false
}

export interface AutomationExecutionDiagnostics {
  runs: AutomationExecution[]
  automaticReplay: false
  serviceRequired: true
  offlinePolicy: string
}

const statuses = new Set<AutomationExecutionStatus>([
  'waiting',
  'creating_thread',
  'starting_turn',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'coalesced',
  'expired',
  'unknown',
])

/** Legacy servers have no execution contract; never infer it from last_fired_at. */
export function automationExecutionDiagnostics(
  value: unknown
): AutomationExecutionDiagnostics | null {
  if (!value || typeof value !== 'object') return null
  const diagnostics = (value as Record<string, unknown>).executionDiagnostics
  if (!diagnostics || typeof diagnostics !== 'object') return null
  const runs = (diagnostics as Record<string, unknown>).runs
  if (!Array.isArray(runs)) return null
  const parsed: AutomationExecution[] = []
  const ids = new Set<string>()
  for (const item of runs.slice(0, 1024)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (
      typeof record.triggerId !== 'string' ||
      typeof record.jobId !== 'string' ||
      typeof record.scheduledAt !== 'string' ||
      typeof record.recordedAt !== 'string' ||
      ids.has(record.triggerId)
    ) {
      continue
    }
    ids.add(record.triggerId)
    const status = statuses.has(record.status as AutomationExecutionStatus)
      ? (record.status as AutomationExecutionStatus)
      : 'unknown'
    // An incompatible/partial success record is uncertain, even when delivery was confirmed.
    const confirmed =
      status === 'succeeded' &&
      typeof record.threadId === 'string' &&
      typeof record.turnId === 'string' &&
      typeof record.attemptId === 'string' &&
      typeof record.replyPreview === 'string' &&
      record.replyPreview.trim().length > 0
    parsed.push({
      triggerId: record.triggerId,
      jobId: record.jobId,
      scheduledAt: record.scheduledAt,
      recordedAt: record.recordedAt,
      title: typeof record.title === 'string' ? record.title : undefined,
      coalesced:
        typeof record.coalesced === 'number' &&
        Number.isSafeInteger(record.coalesced) &&
        record.coalesced >= 0
          ? record.coalesced
          : undefined,
      workspacePath: typeof record.workspacePath === 'string' ? record.workspacePath : null,
      threadId: typeof record.threadId === 'string' ? record.threadId : null,
      turnId: typeof record.turnId === 'string' ? record.turnId : null,
      attemptId: typeof record.attemptId === 'string' ? record.attemptId : null,
      model: typeof record.model === 'string' ? record.model : null,
      timezone:
        record.schedule && typeof record.schedule === 'object'
          ? 'timezone' in record.schedule && typeof record.schedule.timezone === 'string'
            ? record.schedule.timezone
            : 'UTC'
          : null,
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
      finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
      replyPreview: typeof record.replyPreview === 'string' ? record.replyPreview : null,
      error: typeof record.error === 'string' ? record.error : null,
      failureStage: typeof record.failureStage === 'string' ? record.failureStage : null,
      mergedIntoTriggerId:
        typeof record.mergedIntoTriggerId === 'string' ? record.mergedIntoTriggerId : null,
      status: status === 'succeeded' && !confirmed ? 'unknown' : status,
      automaticReplay: false,
    } as AutomationExecution)
  }
  return {
    runs: parsed,
    automaticReplay: false,
    serviceRequired: true,
    offlinePolicy: 'wait-for-host-and-service; coalesce-missed; expire-after-seven-days',
  }
}

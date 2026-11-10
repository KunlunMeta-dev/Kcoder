import { MIGRATION_HISTORY_CONCURRENCY, runMigrationTasks } from './migrationTaskPool'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { createMigrationApi } from './gatewayMigration'
import type {
  HistorySourceSummary,
  HistoricalAttachmentSelection,
  HistoricalContextIssue,
  MigrationHistoryJobResult,
  StudioWorkMode,
} from '../../../shared/generated/contracts'

export type QuickHistoryApi = Pick<
  ReturnType<typeof createMigrationApi>,
  | 'historyDiscover'
  | 'historySources'
  | 'historyCreate'
  | 'historyRead'
  | 'historyRun'
  | 'historyResume'
  | 'historyCancel'
  | 'historyAttachmentItems'
  | 'historyAttachmentRead'
  | 'historyAttachmentRun'
  | 'historyAttachmentResume'
  | 'historyAttachmentCancel'
  | 'branchPrepare'
  | 'branchRead'
  | 'branchRun'
  | 'branchResume'
  | 'branchCancel'
  | 'branchToolsRead'
  | 'branchToolsRun'
  | 'branchToolsResume'
  | 'branchToolsCancel'
  | 'continuationCreate'
  | 'continuationRead'
  | 'continuationRun'
  | 'continuationResume'
  | 'continuationCancel'
  | 'continuationSource'
  | 'undoLookup'
> &
  Partial<Pick<ReturnType<typeof createMigrationApi>, 'historyConcurrency'>>
export type QuickSource = 'claude-code' | 'codex'
export type QuickPhase =
  'idle' | 'discovering' | 'preparing' | 'archiving' | 'continuing' | 'paused' | 'complete'
export type QuickRow = {
  source: HistorySourceSummary
  catalogId: string
  jobId: string
  viewId?: string
  threadId?: string
  archiveReady?: boolean
  reconstructed?: boolean
  status: 'pending' | 'archiving' | 'archived' | 'continuing' | 'imported' | 'failed'
  error?: string
}
export type QuickSnapshot = {
  phase: QuickPhase
  busy: boolean
  rows: readonly QuickRow[]
  warnings: readonly { source: QuickSource; code: string }[]
  error: string
  concurrency?: number
  requiresUpdate?: boolean
}
type QuickHistoryOptions = {
  api: QuickHistoryApi
  namespace: string
  isCurrent: () => boolean
  sleep?: () => Promise<void>
  concurrency?: number
  maxObservations?: number
}
class Stopped extends Error {}
class AttachmentsRequired extends Error {
  readonly viewId: string
  readonly issues: readonly HistoricalContextIssue[]
  constructor(viewId: string, issues: readonly HistoricalContextIssue[]) {
    super('history_context_attachment_required')
    this.viewId = viewId
    this.issues = issues
  }
}
const RECOVERABLE_ATTACHMENT_ISSUES = new Set([
  'history_context_attachment_required',
  'history_context_attachment_not_ready',
  'history_context_attachment_collection_required',
])
const RETRYABLE_HISTORY_CONTENTION = new Set([
  'history_catalog_busy',
  'history_job_busy',
  'history_context_preparation_busy',
  'continuation_busy',
  'history_attachment_job_busy',
  'history_attachment_busy',
])
export const quickHistoryError = (cause: unknown) =>
  (cause instanceof Error ? cause.message : '').match(
    /\b(?:migration|history|external_history|continuation|historical_projection|historical_seed|historical_undo)_[a-z_]+\b/
  )?.[0] ?? 'error'

/** Stable request identities are checked by Native against the actual source binding.
 * They are recovery locators, never proof that a previous operation succeeded. */
export function quickHistoryId(...parts: unknown[]): string {
  const bytes = sha256(
    new TextEncoder().encode(JSON.stringify(['quick-history/v1', ...parts]))
  ).slice(0, 16)
  bytes[6] = (bytes[6] & 15) | 80
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One UI-owned queue composes existing durable Native operations. No model turns run here. */
export class QuickHistoryMigration {
  private snapshot: QuickSnapshot = {
    phase: 'idle',
    busy: false,
    rows: [],
    warnings: [],
    error: '',
  }
  private listeners = new Set<() => void>()
  private stopped = false
  private disposed = false
  private reads = new AbortController()
  private activeCancels = new Map<string, () => Promise<unknown>>()
  private concurrency = MIGRATION_HISTORY_CONCURRENCY
  private readonly options: QuickHistoryOptions
  constructor(options: QuickHistoryOptions) {
    const concurrency = options.concurrency ?? MIGRATION_HISTORY_CONCURRENCY
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MIGRATION_HISTORY_CONCURRENCY
    )
      throw new Error('migration_history_concurrency_invalid')
    this.options = options
    this.concurrency = concurrency
  }
  private cancellation(row: QuickRow, cancel?: () => Promise<unknown>) {
    if (cancel) this.activeCancels.set(row.jobId, cancel)
    else this.activeCancels.delete(row.jobId)
  }
  private parallel<T>(
    rows: readonly T[],
    key: (row: T) => string,
    work: (row: T) => Promise<void>
  ) {
    return runMigrationTasks(
      rows,
      { concurrency: this.concurrency, key, check: () => this.check() },
      work
    )
  }
  getSnapshot = () => this.snapshot
  activate = () => {
    this.disposed = false
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private valid() {
    return !this.disposed && this.options.isCurrent()
  }
  private check() {
    if (!this.valid() || this.stopped) throw new Stopped()
  }
  private update(value: Partial<QuickSnapshot>) {
    if (!this.valid()) return
    this.snapshot = { ...this.snapshot, ...value }
    this.listeners.forEach(listener => listener())
  }
  private row(row: QuickRow, patch: Partial<QuickRow>) {
    this.check()
    Object.assign(row, patch)
    this.update({ rows: [...this.snapshot.rows] })
  }
  private async call<T>(action: () => Promise<T>): Promise<T> {
    this.check()
    const result = await action()
    this.check()
    return result
  }
  private async poll<T>(read: () => Promise<T>, inspect: (value: T) => boolean) {
    for (let attempt = 0; attempt < (this.options.maxObservations ?? 7200); attempt++) {
      this.check()
      let value: T
      try {
        value = await this.call(read)
      } catch (cause) {
        // Only a typed public contention code permits a repeated observation.
        if (cause instanceof Stopped || !RETRYABLE_HISTORY_CONTENTION.has(quickHistoryError(cause)))
          throw cause
        await (this.options.sleep?.() ?? new Promise(resolve => setTimeout(resolve, 500)))
        continue
      }
      if (inspect(value)) return value
      await (this.options.sleep?.() ?? new Promise(resolve => setTimeout(resolve, 500)))
    }
    throw new Error('migration_quick_observation_timeout')
  }
  private async reconcileAfterContention(row: QuickRow, mode: StudioWorkMode) {
    let attempts = 0
    let attachmentPasses = 0
    let attachments: AttachmentsRequired | undefined
    for (;;) {
      try {
        if (attachments) {
          await this.prepareAttachments(row, attachments)
          attachments = undefined
        }
        await this.continue(row, mode)
        return
      } catch (cause) {
        if (cause instanceof AttachmentsRequired && attachmentPasses < 3) {
          attachmentPasses++
          attachments = cause
          continue
        }
        if (
          cause instanceof Stopped ||
          !RETRYABLE_HISTORY_CONTENTION.has(quickHistoryError(cause)) ||
          attempts >= 7
        )
          throw cause
        // Re-enter through durable branch and continuation identities; unknown
        // transport outcomes are never retried by this contention path.
        this.check()
        const spread = parseInt(row.jobId.slice(0, 4), 16) % 1000
        await (this.options.sleep?.() ??
          new Promise(resolve =>
            setTimeout(resolve, Math.min(4000, 400 * (attempts + 1)) + spread)
          ))
        attempts++
        this.check()
      }
    }
  }
  private async prepareAttachment(row: QuickRow, selection: HistoricalAttachmentSelection) {
    const { api } = this.options
    const params = { selection }
    const current = await this.call(() =>
      api.historyAttachmentRead(params, { signal: this.reads.signal })
    )
    const job = current.job
    if (
      !current.workerRunning &&
      current.workerError &&
      !['failed', 'cancelled'].includes(job?.stage ?? '')
    )
      throw new Error(current.workerError)
    this.cancellation(row, () => api.historyAttachmentCancel(params))
    if (
      !current.workerRunning &&
      !['ready', 'catalogued', 'unavailable'].includes(job?.stage ?? '')
    ) {
      await this.call(() =>
        job && ['failed', 'cancelled'].includes(job.stage)
          ? api.historyAttachmentResume({ ...params, expectedSequence: job.sequence })
          : api.historyAttachmentRun(params)
      )
    }
    const settled = await this.poll(
      () => api.historyAttachmentRead(params, { signal: this.reads.signal }),
      value => {
        if (value.workerRunning) return false
        if (!value.job) throw new Error('history_attachment_job_missing')
        if (value.job?.stage === 'ready' || value.job?.stage === 'catalogued') return true
        this.failure(
          value.job?.stage,
          value.workerError ??
            value.job?.failureCode ??
            (value.job?.stage === 'unavailable' ? 'history_attachment_unavailable' : undefined)
        )
        if (['planned', 'inspecting', 'extracting'].includes(value.job.stage))
          throw new Error('history_attachment_execution_unknown')
        return false
      }
    )
    this.cancellation(row)
    if (!settled.job) throw new Error('history_attachment_job_missing')
    if (
      settled.job.stage === 'ready' &&
      (!settled.job.info?.receipt ||
        !['embedded_base64', 'embedded_text'].includes(settled.job.info.kind))
    )
      throw new Error('history_attachment_unavailable')
    return settled.job
  }
  private async prepareAttachments(row: QuickRow, needed: AttachmentsRequired) {
    const positions = new Map<string, HistoricalAttachmentSelection>()
    for (const issue of needed.issues) {
      if (
        !Number.isSafeInteger(issue.position) ||
        !Number.isSafeInteger(issue.blockIndex) ||
        issue.position! < 0 ||
        issue.blockIndex! < 0
      )
        throw new Error('history_attachment_selection_invalid')
      const selection: HistoricalAttachmentSelection = {
        jobId: row.jobId,
        viewId: needed.viewId,
        position: issue.position!,
        blockIndex: issue.blockIndex!,
        toolItemIndex: null,
      }
      positions.set(`${selection.position}:${selection.blockIndex}`, selection)
    }
    if (positions.size === 0 || positions.size > 256)
      throw new Error('history_attachment_budget_exceeded')
    let total = 0
    for (const selection of positions.values()) {
      const job = await this.prepareAttachment(row, selection)
      if (job.stage === 'ready') {
        if (++total > 256) throw new Error('history_attachment_budget_exceeded')
        continue
      }
      if (
        job.stage !== 'catalogued' ||
        !job.catalog?.structured ||
        !Number.isSafeInteger(job.catalog.attachments) ||
        job.catalog.attachments < 1 ||
        job.catalog.attachments > 256
      )
        throw new Error('history_attachment_unavailable')
      const seen = new Set<number>()
      let cursor = 0
      for (;;) {
        const page = await this.call(() =>
          this.options.api.historyAttachmentItems(
            { selection, cursor },
            { signal: this.reads.signal }
          )
        )
        if (!page.summary.structured || page.summary.attachments !== job.catalog.attachments)
          throw new Error('history_attachment_catalog_changed')
        for (const item of page.items) {
          if (
            !Number.isSafeInteger(item.index) ||
            item.index < 0 ||
            item.index >= job.catalog.attachments ||
            seen.has(item.index) ||
            ++total > 256
          )
            throw new Error('history_attachment_catalog_changed')
          seen.add(item.index)
          const result = await this.prepareAttachment(row, {
            ...selection,
            toolItemIndex: item.index,
          })
          if (result.stage !== 'ready') throw new Error('history_attachment_unavailable')
        }
        if (page.nextCursor == null) break
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor)
          throw new Error('history_attachment_catalog_changed')
        cursor = page.nextCursor
      }
      if (seen.size !== job.catalog.attachments)
        throw new Error('history_attachment_catalog_changed')
    }
  }
  private failure(stage: string | undefined, error: string | null | undefined) {
    if (error || (stage && ['failed', 'cancelled', 'blocked', 'publish_unknown'].includes(stage)))
      throw new Error(error || 'migration_quick_needs_review')
  }
  private async discover(kinds: readonly QuickSource[]) {
    const { api, namespace } = this.options
    const rows: QuickRow[] = [],
      warnings: { source: QuickSource; code: string }[] = []
    for (const source of kinds) {
      this.check()
      try {
        let page = await this.call(() =>
          api.historyDiscover({ source }, { signal: this.reads.signal })
        )
        const catalogId = page.catalogId,
          cursors = new Set<string>(),
          seen = new Set<string>()
        for (;;) {
          if (page.catalogId !== catalogId) throw new Error('migration_invalid_result')
          if (!page.discoveryComplete)
            warnings.push({ source, code: 'history_discovery_incomplete' })
          for (const item of page.items) {
            if (item.source !== source || seen.has(item.sourceHandle))
              throw new Error('migration_invalid_result')
            seen.add(item.sourceHandle)
            if (rows.length >= 20000) throw new Error('history_discovery_budget_exceeded')
            rows.push({
              source: item,
              catalogId,
              jobId: quickHistoryId(
                namespace,
                source,
                item.sourceSessionId,
                item.sourceArtifactId,
                item.agentId,
                item.bytes,
                item.modifiedAtMs
              ),
              status: item.importIssues.length ? 'failed' : 'pending',
              error: item.importIssues[0],
            })
          }
          this.update({ rows: [...rows] })
          if (!page.nextCursor) break
          if (cursors.has(page.nextCursor)) throw new Error('migration_invalid_result')
          cursors.add(page.nextCursor)
          const cursor = page.nextCursor
          page = await this.call(() =>
            api.historySources({ catalogId, cursor }, { signal: this.reads.signal })
          )
        }
      } catch (cause) {
        if (cause instanceof Stopped) throw cause
        warnings.push({ source, code: quickHistoryError(cause) })
      }
    }
    this.update({
      rows,
      warnings: warnings.filter(
        (row, at) =>
          warnings.findIndex(other => other.source === row.source && other.code === row.code) === at
      ),
    })
  }
  private async archive(row: QuickRow, initial: MigrationHistoryJobResult) {
    const { api } = this.options
    this.row(row, { status: 'archiving' })
    this.cancellation(
      row,
      initial.job.stage !== 'normalized' || initial.workerRunning
        ? () => api.historyCancel(row.jobId)
        : undefined
    )
    let value = initial
    if (value.workerState === 'unknown') throw new Error('history_job_execution_unknown')
    if (!value.workerRunning && value.job.stage !== 'normalized') {
      const params = { jobId: row.jobId, expectedSequence: value.job.sequence }
      if (
        ['failed', 'cancelled'].includes(value.job.stage) ||
        value.job.failureCode === 'history_projection_recovery_required'
      )
        value = await this.call(() => api.historyResume(params))
      if (!value.workerRunning)
        value = await this.call(() =>
          api.historyRun({ jobId: row.jobId, expectedSequence: value.job.sequence })
        )
    }
    await this.poll(
      () => api.historyRead(row.jobId, { signal: this.reads.signal }),
      current => {
        if (current.workerState === 'unknown') throw new Error('history_job_execution_unknown')
        if (current.workerRunning) return false
        if (current.job.stage === 'normalized' && !current.job.failureCode) return true
        this.failure(current.job.stage, current.workerError ?? current.job.failureCode)
        return false
      }
    )
    this.row(row, { status: 'archived', archiveReady: true })
    this.cancellation(row)
  }
  private relatives(row: QuickRow) {
    if (row.source.source !== 'codex') return []
    const ids: string[] = [],
      seen = new Set<string>([row.source.sourceSessionId])
    let parent = row.source.parentSessionId
    while (parent) {
      if (seen.has(parent) || ids.length >= 255) throw new Error('history_branch_invalid_sources')
      seen.add(parent)
      const matches = this.snapshot.rows.filter(
        other =>
          other.source.source === 'codex' &&
          other.source.sourceSessionId === parent &&
          other.archiveReady
      )
      if (matches.length !== 1) throw new Error('migration_quick_parent_unavailable')
      ids.push(matches[0].jobId)
      parent = matches[0].source.parentSessionId
    }
    return ids
  }
  private async continue(row: QuickRow, mode: StudioWorkMode) {
    const { api } = this.options
    this.cancellation(row)
    this.row(row, { status: 'continuing' })
    let relatedJobIds = this.relatives(row)
    let attemptedReconstructionView: string | undefined
    const prepareBranch = async (
      reconstructReadable: boolean,
      rejected?: { viewId: string; code: string }
    ) => {
      const prepared = await this.call(() =>
        api.branchPrepare({
          jobId: row.jobId,
          relatedJobIds,
          ...(reconstructReadable ? { reconstructReadable: true } : {}),
        })
      )
      const progress = prepared.progress
      if (!progress) throw new Error('history_branch_not_ready')
      if (rejected && progress.viewId === rejected.viewId) throw new Error(rejected.code)
      if (reconstructReadable) attemptedReconstructionView = progress.viewId
      const params = { jobId: row.jobId, viewId: progress.viewId }
      this.row(row, { viewId: progress.viewId })
      this.cancellation(
        row,
        progress.stage !== 'ready' || prepared.workerRunning
          ? () => api.branchCancel(params)
          : undefined
      )
      if (!prepared.workerRunning && progress.stage !== 'ready') {
        if (['failed', 'cancelled'].includes(progress.stage))
          await this.call(() =>
            api.branchResume({ ...params, expectedSequence: progress.sequence })
          )
        await this.call(() => api.branchRun(params))
      }
      const ready = await this.poll(
        () => api.branchRead(params, { signal: this.reads.signal }),
        value => {
          if (value.workerRunning) return false
          if (value.progress?.stage === 'ready') return true
          this.failure(value.progress?.stage, value.workerError ?? value.progress?.failureCode)
          return false
        }
      )
      this.cancellation(row)
      if (!ready.progress) throw new Error('history_branch_not_ready')
      return ready.progress
    }
    let progress = await prepareBranch(false)
    if (
      row.source.source === 'codex' &&
      progress.issues.includes('codex_history_base_unresolved')
    ) {
      // Physical rollout versions of one logical session can contain an explicit
      // history_base. Native verifies the exact artifact and prefix before use.
      const siblings = this.snapshot.rows
        .filter(
          other =>
            other.jobId !== row.jobId &&
            other.archiveReady &&
            other.source.source === 'codex' &&
            other.source.sourceSessionId === row.source.sourceSessionId &&
            other.source.sourceArtifactId
        )
        .map(other => other.jobId)
      const merged = [...new Set([...relatedJobIds, ...siblings])]
      if (merged.length >= 256) throw new Error('history_branch_invalid_sources')
      if (merged.length > relatedJobIds.length) {
        relatedJobIds = merged
        progress = await prepareBranch(false)
      }
    }
    if (
      row.source.source === 'codex' &&
      relatedJobIds.length === 0 &&
      progress.issues.includes('source_records_require_review')
    ) {
      try {
        progress = await prepareBranch(true)
      } catch (cause) {
        // A failed legacy reconstruction can be followed only by a distinct
        // native recipe; older targets must never rerun the same failed view.
        const code = quickHistoryError(cause)
        if (
          ![
            'history_reconstruction_checkpoint_unsupported',
            'history_reconstruction_checkpoint_not_found',
            'history_reconstruction_source_requires_review',
          ].includes(code) ||
          !attemptedReconstructionView
        )
          throw cause
        progress = await prepareBranch(true, { viewId: attemptedReconstructionView, code })
      }
      if (!progress.issues.includes('codex_readable_reconstruction_requires_admission'))
        throw new Error('migration_invalid_result')
      this.row(row, { reconstructed: true })
    }
    const viewId = progress.viewId,
      params = { jobId: row.jobId, viewId }
    const tools = await this.poll(
      () => api.branchToolsRead(params, { signal: this.reads.signal }),
      () => true
    )
    this.cancellation(
      row,
      tools.state.run?.stage !== 'ready' || tools.state.workerRunning
        ? () => api.branchToolsCancel(params)
        : undefined
    )
    if (!tools.state.workerRunning && tools.state.run?.stage !== 'ready') {
      const run = tools.state.run
      await this.call(() =>
        run && ['failed', 'cancelled'].includes(run.stage)
          ? api.branchToolsResume({ ...params, expectedSequence: run.sequence })
          : api.branchToolsRun(params)
      )
    }
    await this.poll(
      () => api.branchToolsRead(params, { signal: this.reads.signal }),
      value => {
        if (value.state.workerRunning) return false
        if (value.state.run?.stage === 'ready') return true
        this.failure(value.state.run?.stage, value.workerError ?? value.state.run?.failureCode)
        return false
      }
    )
    this.cancellation(row)
    const requestId = quickHistoryId(
      this.options.namespace,
      'continuation',
      row.jobId,
      viewId,
      mode
    )
    // Reusing this exact intent lets Native reconcile a lost receipt without another session.
    const created = await this.call(() =>
      api.continuationCreate({
        requestId,
        sourceJobId: row.jobId,
        viewId,
        policy: {
          maxContextBytes: 4194304,
          maxEntries: 2048,
          maxAttachments: 256,
          maxAttachmentBytes: 536870912,
        },
        options: { model: null, settingsTemplate: null, studioWorkMode: mode },
      })
    )
    this.cancellation(
      row,
      created.job.stage !== 'imported' || created.workerRunning
        ? () => api.continuationCancel({ jobId: requestId })
        : undefined
    )
    if (!created.workerRunning && created.job.stage !== 'imported') {
      const input = { jobId: requestId, expectedSequence: created.job.sequence }
      await this.call(() =>
        created.job.stage === 'planned' ? api.continuationRun(input) : api.continuationResume(input)
      )
    }
    const imported = await this.poll(
      () => api.continuationRead({ jobId: requestId }, { signal: this.reads.signal }),
      value => {
        if (value.workerRunning) return false
        if (value.job.stage === 'imported') return true
        const report = value.job.compilation
        if (
          value.job.stage === 'blocked' &&
          report &&
          !report.issuesTruncated &&
          report.issues.length > 0 &&
          report.issues.every(issue => RECOVERABLE_ATTACHMENT_ISSUES.has(issue.code))
        )
          throw new AttachmentsRequired(viewId, report.issues)
        // Blocked continuations carry their actionable cause in the compilation or
        // model projection report, rather than in failureCode.
        const issue =
          value.job.stage === 'blocked'
            ? (value.job.compilation?.issues[0]?.code ?? value.job.projection?.issues[0]?.code)
            : undefined
        this.failure(value.job.stage, value.workerError ?? value.job.failureCode ?? issue)
        return false
      }
    )
    this.cancellation(row)
    if (!imported.job.threadId) throw new Error('migration_invalid_result')
    const undone = await this.poll(
      () => api.undoLookup({ continuationJobId: requestId }, { signal: this.reads.signal }),
      () => true
    )
    if (undone.existingJob) throw new Error('migration_quick_retired')
    const origin = await this.poll(
      () =>
        api.continuationSource({ threadId: imported.job.threadId! }, { signal: this.reads.signal }),
      () => true
    )
    if (origin.source?.sourceJobId !== row.jobId || origin.source.viewId !== viewId)
      throw new Error('migration_quick_thread_unavailable')
    this.row(row, { status: 'imported', threadId: imported.job.threadId })
  }
  start = async (sources: readonly QuickSource[], mode: StudioWorkMode) => {
    if (this.snapshot.busy || !this.valid() || !sources.length) return
    this.stopped = false
    this.reads = new AbortController()
    this.update({ busy: true, phase: 'discovering', rows: [], warnings: [], error: '' })
    try {
      if (this.options.api.historyConcurrency) {
        const capacity = await this.call(() =>
          this.options.api.historyConcurrency!({ signal: this.reads.signal })
        )
        if (
          !Number.isSafeInteger(capacity.maxConcurrentJobs) ||
          capacity.maxConcurrentJobs < 1 ||
          capacity.maxConcurrentJobs > MIGRATION_HISTORY_CONCURRENCY
        )
          throw new Error('migration_invalid_result')
        this.concurrency = Math.min(
          this.options.concurrency ?? MIGRATION_HISTORY_CONCURRENCY,
          capacity.maxConcurrentJobs
        )
        this.update({ concurrency: this.concurrency, requiresUpdate: capacity.requiresUpdate })
      }
      await this.discover([...new Set(sources)])
      this.check()
      this.update({ phase: 'preparing' })
      const rows = this.snapshot.rows.filter(row => row.status !== 'failed')
      const gates = new Map<
        QuickRow,
        {
          promise: Promise<MigrationHistoryJobResult | undefined>
          resolve: (value?: MigrationHistoryJobResult) => void
        }
      >()
      for (const row of rows) {
        let resolve!: (value?: MigrationHistoryJobResult) => void
        const promise = new Promise<MigrationHistoryJobResult | undefined>(done => {
          resolve = done
        })
        gates.set(row, { promise, resolve })
      }
      // Accept source selections in order before their catalog expires. Durable metadata
      // acceptance can overlap IO for earlier, independent jobs; it never shares their runner.
      const preparing = (async () => {
        try {
          for (const row of rows) {
            this.check()
            try {
              const value = await this.call(() =>
                this.options.api.historyCreate({
                  catalogId: row.catalogId,
                  sourceHandle: row.source.sourceHandle,
                  requestId: row.jobId,
                })
              )
              if (value.job.jobId !== row.jobId || value.job.source !== row.source.source)
                throw new Error('migration_invalid_result')
              gates.get(row)!.resolve(value)
            } catch (cause) {
              this.failed(row, cause)
              gates.get(row)!.resolve()
            }
          }
        } finally {
          // A paused or invalidated producer must not leave a lane waiting for a new admission.
          for (const gate of gates.values()) gate.resolve()
        }
      })()
      const archiving = this.parallel(
        rows,
        row => row.jobId,
        async row => {
          const value = await gates.get(row)!.promise
          this.check()
          if (!value) return
          this.update({ phase: 'archiving' })
          try {
            await this.archive(row, value)
          } catch (cause) {
            this.failed(row, cause)
          }
        }
      )
      const completed = await Promise.allSettled([preparing, archiving])
      for (const result of completed) if (result.status === 'rejected') throw result.reason
      this.check()
      // Codex parent archives form a dependency barrier; no child branch observes a partial parent.
      this.update({ phase: 'continuing' })
      await this.parallel(
        this.snapshot.rows.filter(row => row.status === 'archived'),
        row => row.jobId,
        async row => {
          try {
            await this.reconcileAfterContention(row, mode)
          } catch (cause) {
            this.failed(row, cause)
          }
        }
      )
      this.check()
      this.update({ phase: 'complete' })
    } catch (cause) {
      this.update(
        cause instanceof Stopped
          ? { phase: 'paused' }
          : { phase: 'paused', error: quickHistoryError(cause) }
      )
    } finally {
      this.activeCancels.clear()
      this.update({ busy: false })
    }
  }
  private failed(row: QuickRow, cause: unknown) {
    if (cause instanceof Stopped || !this.valid() || this.stopped) throw new Stopped()
    this.row(row, { status: 'failed', error: quickHistoryError(cause) })
    // A failed observation does not prove the last admitted Native worker exited.
    // Retain its original cancellation slot while peer lanes remain active.
  }
  pause = async () => {
    if (!this.snapshot.busy || this.stopped) return
    this.stopped = true
    this.reads.abort()
    const cancellations = [...this.activeCancels.entries()]
    await runMigrationTasks(
      cancellations,
      { concurrency: this.concurrency, key: ([id]) => id, check: () => {} },
      async ([, cancel]) => {
        if (!this.valid()) return
        try {
          await cancel()
        } catch {
          this.update({ error: 'migration_quick_pause_unknown' })
        }
      }
    )
  }
  dispose = () => {
    this.disposed = true
    this.stopped = true
    this.reads.abort()
    this.listeners.clear()
  }
}

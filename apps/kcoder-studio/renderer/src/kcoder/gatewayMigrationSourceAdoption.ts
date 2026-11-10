import { validReceivedProjectRows } from '../../../shared/migrationProjects'
import { validInstructionMappings } from '../../../shared/migrationInstructionMappings'
import {
  isMigrationSourceReceivedParams,
  isMigrationSourceReceivedResult,
  isMigrationSourceAdoptionParams,
  isMigrationSourceAdoptionPrepareParams,
  isMigrationSourceAdoptionResumeParams,
  isMigrationSourceAdoptionCancelParams,
  isMigrationSourceAdoptionResult,
  type MigrationSourceReceivedParams,
  type MigrationSourceReceivedResult,
  type MigrationSourceAdoptionParams,
  type MigrationSourceAdoptionPrepareParams,
  type MigrationSourceAdoptionResumeParams,
  type MigrationSourceAdoptionCancelParams,
  type MigrationSourceAdoptionResult,
} from '../../../shared/generated/contracts'
import {
  createMigrationSourceHttpTransport,
  type MigrationSourceHttpOptions,
} from './gatewayMigrationSourceHttp'

/** Preparing a preview never authorizes publication through the ordinary batch API. */
export function createMigrationSourceAdoptionClient(options: MigrationSourceHttpOptions) {
  const request = createMigrationSourceHttpTransport(
    options,
    'source-transfer',
    new Set(['received', 'adoption-read'])
  )
  const matches = (
    locator: MigrationSourceAdoptionParams,
    value: unknown
  ): value is MigrationSourceAdoptionResult => {
    if (!isMigrationSourceAdoptionResult(value)) return false
    const state = value.state
    if (!state) return true
    return (
      state.requestId === locator.requestId &&
      state.adoptionId === locator.adoptionId &&
      state.completedSources <= state.totalSources &&
      state.totalSources <= 64 &&
      new Set(state.jobs.map(job => job.jobId)).size === state.jobs.length &&
      (state.phase !== 'preview_ready' || state.completedSources === state.totalSources)
    )
  }
  return {
    received: (input: MigrationSourceReceivedParams, signal?: AbortSignal) =>
      request<MigrationSourceReceivedResult>(
        'received',
        { ...input, includeProjects: true, includePlugins: true, includeInstructions: true },
        isMigrationSourceReceivedParams,
        (value): value is MigrationSourceReceivedResult =>
          isMigrationSourceReceivedResult(value) && validReceivedProjectRows(value.items) &&
          value.receipt.requestId === input.requestId &&
          value.receipt.manifestSha256 === input.manifestSha256 &&
          new Set(value.items.map(item => item.entryId)).size === value.items.length &&
          value.totalSources <= 1024 &&
          (value.nextPage === null || value.nextPage === input.pageIndex + 1),
        signal
      ),
    prepare: (input: MigrationSourceAdoptionPrepareParams, signal?: AbortSignal) =>
      request<MigrationSourceAdoptionResult>(
        'adoption-prepare',
        input,
        value =>
          isMigrationSourceAdoptionPrepareParams(value) &&
          new Set(value.selections.map(item => item.entryId)).size === value.selections.length && validInstructionMappings(value.instructionMappings ?? [], value.selections),
        (value): value is MigrationSourceAdoptionResult => matches(input.locator, value),
        signal
      ),
    read: (input: MigrationSourceAdoptionParams, signal?: AbortSignal) =>
      request<MigrationSourceAdoptionResult>(
        'adoption-read',
        input,
        isMigrationSourceAdoptionParams,
        (value): value is MigrationSourceAdoptionResult => matches(input, value),
        signal
      ),
    resume: (input: MigrationSourceAdoptionResumeParams, signal?: AbortSignal) =>
      request<MigrationSourceAdoptionResult>(
        'adoption-resume',
        input,
        isMigrationSourceAdoptionResumeParams,
        (value): value is MigrationSourceAdoptionResult => matches(input.locator, value),
        signal
      ),
    cancel: (input: MigrationSourceAdoptionCancelParams, signal?: AbortSignal) =>
      request<MigrationSourceAdoptionResult>(
        'adoption-cancel',
        input,
        isMigrationSourceAdoptionCancelParams,
        (value): value is MigrationSourceAdoptionResult => matches(input.locator, value),
        signal
      ),
  }
}

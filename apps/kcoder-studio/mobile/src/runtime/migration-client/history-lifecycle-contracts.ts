import * as C from '../../../../shared/generated/contracts'
export interface HistoryLifecycleCalls {
  historyViewOpen: [C.MigrationHistoryViewOpenParams, C.MigrationHistoryViewResult]
  historyViewRead: [C.MigrationHistoryViewReadParams, C.MigrationHistoryViewResult]
  historyViewRenew: [C.MigrationHistoryViewRenewParams, C.MigrationHistoryViewResult]
  historyViewRelease: [C.MigrationHistoryViewReleaseParams, C.MigrationHistoryViewResult]
  retirementPreview: [C.MigrationArchiveRetirementPreviewParams, C.MigrationArchiveRetirementPreviewResult]
  retirementPrepare: [C.MigrationArchiveRetirementPrepareParams, C.MigrationArchiveRetirementStateResult]
  retirementRead: [C.MigrationArchiveRetirementReadParams, C.MigrationArchiveRetirementStateResult]
  retirementList: [C.MigrationArchiveRetirementListParams, C.MigrationArchiveRetirementListResult]
  retirementRun: [C.MigrationArchiveRetirementControlParams, C.MigrationArchiveRetirementStateResult]
  retirementCancel: [C.MigrationArchiveRetirementReadParams, C.MigrationArchiveRetirementStateResult]
  retirementResume: [C.MigrationArchiveRetirementControlParams, C.MigrationArchiveRetirementStateResult]
}
const view = (name: string, params: (v: unknown) => boolean) => ({ method: `migration/history/view/${name}`, caps: ['migrationHistoryViewV1'], read: name === 'read', transient: true, params, result: C.isMigrationHistoryViewResult })
const retirement = (name: string, read: boolean, params: (v: unknown) => boolean, result: (v: unknown) => boolean, rows?: string[]) => ({ method: `migration/history/retirement/${name}`, caps: ['migrationArchiveRetirementV1'], read, params, result, rows })
export const HISTORY_LIFECYCLE_CALLS = {
  historyViewOpen: view('open', C.isMigrationHistoryViewOpenParams),
  historyViewRead: view('read', C.isMigrationHistoryViewReadParams),
  historyViewRenew: view('renew', C.isMigrationHistoryViewRenewParams),
  historyViewRelease: view('release', C.isMigrationHistoryViewReleaseParams),
  retirementPreview: retirement('preview', true, C.isMigrationArchiveRetirementPreviewParams, C.isMigrationArchiveRetirementPreviewResult),
  retirementPrepare: retirement('prepare', false, C.isMigrationArchiveRetirementPrepareParams, C.isMigrationArchiveRetirementStateResult),
  retirementRead: retirement('read', true, C.isMigrationArchiveRetirementReadParams, C.isMigrationArchiveRetirementStateResult),
  retirementList: retirement('list', true, C.isMigrationArchiveRetirementListParams, C.isMigrationArchiveRetirementListResult, ['items']),
  retirementRun: retirement('run', false, C.isMigrationArchiveRetirementControlParams, C.isMigrationArchiveRetirementStateResult),
  retirementCancel: retirement('cancel', false, C.isMigrationArchiveRetirementReadParams, C.isMigrationArchiveRetirementStateResult),
  retirementResume: retirement('resume', false, C.isMigrationArchiveRetirementControlParams, C.isMigrationArchiveRetirementStateResult),
}

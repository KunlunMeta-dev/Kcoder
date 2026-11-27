import * as C from '../../../shared/generated/contracts'
import { validHistoryLifecycleResult } from '../../../shared/migrationHistoryLifecycle'
const RETIREMENT_RULES: Record<string, [(v: unknown) => boolean, (v: unknown) => boolean]> = {
  preview: [C.isMigrationArchiveRetirementPreviewParams, C.isMigrationArchiveRetirementPreviewResult],
  prepare: [C.isMigrationArchiveRetirementPrepareParams, C.isMigrationArchiveRetirementStateResult],
  read: [C.isMigrationArchiveRetirementReadParams, C.isMigrationArchiveRetirementStateResult],
  list: [C.isMigrationArchiveRetirementListParams, C.isMigrationArchiveRetirementListResult],
  run: [C.isMigrationArchiveRetirementControlParams, C.isMigrationArchiveRetirementStateResult],
  cancel: [C.isMigrationArchiveRetirementReadParams, C.isMigrationArchiveRetirementStateResult],
  resume: [C.isMigrationArchiveRetirementControlParams, C.isMigrationArchiveRetirementStateResult],
}
export function validateHistoryRetirement(method: string, params: unknown, result?: unknown): boolean {
  const rule = RETIREMENT_RULES[method.split('/').at(-1) ?? '']
  return !!rule && rule[0](params) && (result === undefined || rule[1](result) && validHistoryLifecycleResult(method, params, result))
}
export const HISTORY_LIFECYCLE_METHODS = [
  ...['open', 'read', 'renew', 'release'].map(name => `migration/history/view/${name}`),
  ...['preview', 'prepare', 'read', 'list', 'run', 'cancel', 'resume'].map(name => `migration/history/retirement/${name}`),
]
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createHistoryLifecycleApi(invoke: Invoke) {
  return {
    historyViewOpen: (params: C.MigrationHistoryViewOpenParams) => invoke<C.MigrationHistoryViewResult>('migration/history/view/open', params),
    historyViewRead: (params: C.MigrationHistoryViewReadParams) => invoke<C.MigrationHistoryViewResult>('migration/history/view/read', params),
    historyViewRenew: (params: C.MigrationHistoryViewRenewParams) => invoke<C.MigrationHistoryViewResult>('migration/history/view/renew', params),
    historyViewRelease: (params: C.MigrationHistoryViewReleaseParams) => invoke<C.MigrationHistoryViewResult>('migration/history/view/release', params),
    retirementPreview: (params: C.MigrationArchiveRetirementPreviewParams) => invoke<C.MigrationArchiveRetirementPreviewResult>('migration/history/retirement/preview', params),
    retirementPrepare: (params: C.MigrationArchiveRetirementPrepareParams) => invoke<C.MigrationArchiveRetirementStateResult>('migration/history/retirement/prepare', params),
    retirementRead: (params: C.MigrationArchiveRetirementReadParams) => invoke<C.MigrationArchiveRetirementStateResult>('migration/history/retirement/read', params),
    retirementList: (params: C.MigrationArchiveRetirementListParams) => invoke<C.MigrationArchiveRetirementListResult>('migration/history/retirement/list', params),
    retirementRun: (params: C.MigrationArchiveRetirementControlParams) => invoke<C.MigrationArchiveRetirementStateResult>('migration/history/retirement/run', params),
    retirementCancel: (params: C.MigrationArchiveRetirementReadParams) => invoke<C.MigrationArchiveRetirementStateResult>('migration/history/retirement/cancel', params),
    retirementResume: (params: C.MigrationArchiveRetirementControlParams) => invoke<C.MigrationArchiveRetirementStateResult>('migration/history/retirement/resume', params),
  }
}

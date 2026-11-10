import { requestLocalExecutor } from '@/host/localExecutor'
import type {
  MigrationPluginDiscoverParams,
  MigrationPluginDiscoverResult,
  MigrationPluginPlanParams,
  MigrationPluginOperationParams,
  MigrationPluginStateResult,
  MigrationPluginListResult,
} from '../../../shared/generated/contracts'
export const MIGRATION_PLUGINS_CAPABILITY = 'migrationLocalPluginsV1'
export function createMigrationPluginsApi(deviceId: string, workspacePath?: string) {
  const invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) =>
    requestLocalExecutor<T>(
      'runtime.migration.request',
      { deviceId, workspacePath, method: `migration/plugin/${method}`, params },
      options
    )
  return {
    discover: (params: MigrationPluginDiscoverParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationPluginDiscoverResult>('discover', params, options),
    list: (cursor?: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationPluginListResult>('list', { cursor }, options),
    read: (operationId: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationPluginStateResult>('read', { operationId }, options),
    plan: (params: MigrationPluginPlanParams) => invoke<MigrationPluginStateResult>('plan', params),
    capture: (params: MigrationPluginOperationParams) =>
      invoke<MigrationPluginStateResult>('capture', params),
    apply: (params: MigrationPluginOperationParams) =>
      invoke<MigrationPluginStateResult>('apply', params),
    undo: (params: MigrationPluginOperationParams) =>
      invoke<MigrationPluginStateResult>('undo', params),
    cancel: (params: MigrationPluginOperationParams) =>
      invoke<MigrationPluginStateResult>('cancel', params),
    resume: (params: MigrationPluginOperationParams) =>
      invoke<MigrationPluginStateResult>('resume', params),
  }
}

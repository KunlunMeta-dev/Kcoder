import type {
  MigrationConfigurationLayersParams,
  MigrationCodexLayersReadResult,
  MigrationCodexLayersSelectParams,
  MigrationCodexLayersSelectResult,
} from '../../../shared/generated/contracts'
import {
  isMigrationCodexLayersReadResult,
  isMigrationCodexLayersSelectResult,
} from '../../../shared/generated/contracts'
import {
  validCodexLayerReport,
  validCodexLayerSelection,
} from '../../../shared/migrationCodexLayers'
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createCodexLayersApi(invoke: Invoke) {
  return {
    codexLayersSelect: async (
      params: MigrationCodexLayersSelectParams,
      options?: { signal?: AbortSignal }
    ) => {
      const value = await invoke<MigrationCodexLayersSelectResult>(
        'migration/codex/layers/select',
        params,
        options
      )
      if (!isMigrationCodexLayersSelectResult(value) || !validCodexLayerSelection(params, value))
        throw new Error('migration_invalid_response')
      return value
    },
    codexLayersRead: async (
      params: MigrationConfigurationLayersParams,
      options?: { signal?: AbortSignal }
    ) => {
      const value = await invoke<MigrationCodexLayersReadResult>(
        'migration/codex/layers/read',
        params,
        options
      )
      if (!isMigrationCodexLayersReadResult(value) || !validCodexLayerReport(params, value))
        throw new Error('migration_invalid_response')
      return value
    },
  }
}

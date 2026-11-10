import type * as C from '../../../shared/generated/contracts';
import { validDefinitionCall } from '../../../shared/migrationDefinitions';
export { DEFINITION_METHODS, DEFINITIONS_CAPABILITY, validDefinitionCall } from '../../../shared/migrationDefinitions';
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>;
export function createDefinitionsApi(invoke: Invoke) {
  const call = async <T>(method: string, params: object, options?: { signal?: AbortSignal }) => {
    if (!validDefinitionCall(method, params)) throw new Error('migration_invalid_parameters');
    const result = await invoke<T>(method, params, options);
    if (!validDefinitionCall(method, params, result)) throw new Error('migration_invalid_response');
    return result;
  };
  return {
    definitionsDiscover: (p: C.MigrationDefinitionsDiscoverParams, options?: { signal?: AbortSignal }) => call<C.MigrationDefinitionsDiscoverResult>('migration/definitions/discover', p, options),
    definitionReport: (p: C.MigrationDefinitionReportParams, options?: { signal?: AbortSignal }) => call<C.MigrationDefinitionReportResult>('migration/definitions/report', p, options),
    definitionBody: (p: C.MigrationDefinitionBodyParams, options?: { signal?: AbortSignal }) => call<C.MigrationDefinitionBodyResult>('migration/definitions/body', p, options),
  };
}

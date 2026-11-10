import * as C from '../../../../shared/generated/contracts';
export interface DefinitionsCalls {
  definitionsDiscover: [C.MigrationDefinitionsDiscoverParams, C.MigrationDefinitionsDiscoverResult];
  definitionReport: [C.MigrationDefinitionReportParams, C.MigrationDefinitionReportResult];
  definitionBody: [C.MigrationDefinitionBodyParams, C.MigrationDefinitionBodyResult];
}
const rule = (method: string, params: (value: unknown) => boolean, result: (value: unknown) => boolean) => ({ method: `migration/definitions/${method}`, caps: ['migrationDefinitionsV1'], read: true, params, result });
export const DEFINITIONS_CALLS = {
  definitionsDiscover: rule('discover', C.isMigrationDefinitionsDiscoverParams, C.isMigrationDefinitionsDiscoverResult),
  definitionReport: rule('report', C.isMigrationDefinitionReportParams, C.isMigrationDefinitionReportResult),
  definitionBody: rule('body', C.isMigrationDefinitionBodyParams, C.isMigrationDefinitionBodyResult),
};

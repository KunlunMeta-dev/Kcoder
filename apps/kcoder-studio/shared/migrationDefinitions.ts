import * as C from './generated/contracts';
export const DEFINITIONS_CAPABILITY = 'migrationDefinitionsV1';
export const DEFINITION_METHODS = ['discover', 'report', 'body'].map(name => `migration/definitions/${name}`);
/** Original definition bytes stay inert; neither parsing nor saving grants execution. */
export function validDefinitionCall(method: string, input: unknown, result?: unknown): boolean {
  if (!DEFINITION_METHODS.includes(method)) return false;
  const name = method.slice('migration/definitions/'.length);
  if (name === 'discover') {
    if (!C.isMigrationDefinitionsDiscoverParams(input) || (input.pageIndex ?? 0) > 0 && !input.catalogId) return false;
    if (result === undefined) return true;
    return C.isMigrationDefinitionsDiscoverResult(result) && !!result.catalogId && (!input.catalogId || input.catalogId === result.catalogId)
      && result.sources.length <= 10 && new Set(result.sources.map(row => row.sourceId)).size === result.sources.length
      && result.sources.every(row => (!(input.sources ?? []).length || (input.sources ?? []).includes(row.kind)) && row.availableCategories.length > 0 && row.availableCategories.every(category => category === 'agent' || category === 'hook'))
      && result.totalSources >= result.sources.length && (result.nextPage == null || result.nextPage === (input.pageIndex ?? 0) + 1);
  }
  if (name === 'report') {
    if (!C.isMigrationDefinitionReportParams(input)) return false;
    if (result === undefined) return true;
    return C.isMigrationDefinitionReportResult(result) && result.jobId === input.jobId && result.itemId === input.itemId && result.pageIndex === (input.pageIndex ?? 0)
      && result.report.executionAllowed === false && result.report.requiresReview === true && result.report.fields.length <= 10
      && result.totalFields <= 1024 && new Set(result.report.fields.map(row => `${row.element}:${row.ordinal}`)).size === result.report.fields.length
      && (result.nextPage == null ? result.pageIndex * 10 + result.report.fields.length >= result.totalFields : result.nextPage === result.pageIndex + 1 && result.pageIndex * 10 + result.report.fields.length < result.totalFields);
  }
  if (name === 'body') {
    if (!C.isMigrationDefinitionBodyParams(input)) return false;
    if (result === undefined) return true;
    if (!C.isMigrationDefinitionBodyResult(result) || result.jobId !== input.jobId || result.itemId !== input.itemId || result.offset !== (input.offset ?? 0)
      || ![result.offset, result.totalBytes, ...(result.nextOffset == null ? [] : [result.nextOffset])].every(value => Number.isSafeInteger(value) && value >= 0) || !/^[0-9a-f]{64}$/.test(result.sha256) || result.bytesBase64.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.bytesBase64)) return false;
    try {
      const binary = atob(result.bytesBase64), end = result.offset + binary.length;
      if (btoa(binary) !== result.bytesBase64 || binary.length > 16384 || end > result.totalBytes
        || (result.nextOffset == null ? end !== result.totalBytes : binary.length === 0 || result.nextOffset !== end)) return false;
      return result.encoding === 'binary' ? result.text == null : result.text !== undefined
        && new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))) === result.text;
    } catch { return false; }
  }
  return false;
}

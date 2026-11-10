import * as C from '../../../../shared/generated/contracts';

export interface MemoryCalls {
  memoryDiscover: [C.MigrationMemoryDiscoverParams, C.MigrationMemorySourcesResult];
  memorySources: [C.MigrationMemorySourcesParams, C.MigrationMemorySourcesResult];
  memoryList: [C.MigrationMemoryListParams, C.MigrationMemoryListResult];
  memoryRead: [C.MigrationMemoryReadParams, C.MigrationMemoryReadResult];
  memoryControl: [C.MigrationMemoryControlParams, C.MigrationMemoryControlResult];
  memoryControlRead: [C.MigrationMemoryControlReadParams, C.MigrationMemoryControlResult];
}
const rule = (method: string, read: boolean, params: (v: unknown) => boolean, result: (v: unknown) => boolean, rows?: string[]) =>
  ({ method: `migration/memory/${method}`, caps: ['migrationMemoryV1'], read, params, result, rows });
export const MEMORY_CALLS = {
  memoryDiscover: rule('discover', true, C.isMigrationMemoryDiscoverParams, C.isMigrationMemorySourcesResult, ['items']),
  memorySources: rule('sources', true, C.isMigrationMemorySourcesParams, C.isMigrationMemorySourcesResult, ['items']),
  memoryList: rule('list', true, C.isMigrationMemoryListParams, C.isMigrationMemoryListResult, ['items']),
  memoryRead: rule('read', true, C.isMigrationMemoryReadParams, C.isMigrationMemoryReadResult),
  memoryControl: rule('control', false, C.isMigrationMemoryControlParams, C.isMigrationMemoryControlResult),
  memoryControlRead: rule('control/read', true, C.isMigrationMemoryControlReadParams, C.isMigrationMemoryControlResult),
};

/** A prior control receipt is distinct from the current record and its CAS revision. */
export function validMemoryResult(name: string, input: unknown, result: unknown): boolean {
  if (!(name in MEMORY_CALLS)) return true;
  const p = input as Record<string, any>, r = result as Record<string, any>;
  switch (name) {
    case 'memoryDiscover': return !!r.catalogId && r.items.every((item: C.ImportedMemorySourceSummary) => item.source === p.source)
      && new Set(r.items.map((item: C.ImportedMemorySourceSummary) => item.sourceId)).size === r.items.length;
    case 'memorySources': return r.catalogId === p.catalogId && (r.nextCursor == null || r.nextCursor !== p.cursor)
      && new Set(r.items.map((item: C.ImportedMemorySourceSummary) => item.sourceId)).size === r.items.length;
    case 'memoryList': return (r.nextPage == null || r.nextPage === (p.pageIndex ?? 0) + 1)
      && new Set(r.items.map((item: C.ImportedMemoryRecordSummary) => item.id)).size === r.items.length;
    case 'memoryRead': {
      const bytes = new TextEncoder().encode(r.text).length, end = (p.offset ?? 0) + bytes;
      return r.record.id === p.id && bytes <= 8192 && end <= r.totalBytes &&
        (r.nextOffset == null ? end === r.totalBytes : bytes > 0 && r.nextOffset === end);
    }
    case 'memoryControl': return !!r.receipt && ['requestId', 'id', 'ownerOperationId', 'expectedRevision', 'enabled', 'confirmUnverifiedNotes'].every(key => r.receipt.request[key] === p[key])
      && (!r.current || r.current.id === p.id && r.current.ownerOperationId === p.ownerOperationId);
    case 'memoryControlRead': return (!r.receipt || r.receipt.request.requestId === p.requestId)
      && (!r.current || !!r.receipt && r.current.id === r.receipt.request.id && r.current.ownerOperationId === r.receipt.request.ownerOperationId);
    default: return true;
  }
}

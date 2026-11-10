import type { MigrationHistoryDiscoverParams, MigrationHistorySourcesResult } from '../../../../shared/generated/contracts';
import { HISTORY_FAMILIES_METHOD, HISTORY_FAMILIES_CAPABILITY, validHistoryFamiliesInput, validHistorySources } from '../../../../shared/migrationHistoryFamilies';
export interface HistoryFamiliesCalls { historyFamilies: [MigrationHistoryDiscoverParams, MigrationHistorySourcesResult] }
export const HISTORY_FAMILIES_CALLS = { historyFamilies: { method: HISTORY_FAMILIES_METHOD, caps: [HISTORY_FAMILIES_CAPABILITY],
  read: true, params: validHistoryFamiliesInput, result: (value: unknown) => validHistorySources('codex', value), rows: ['items'] } };

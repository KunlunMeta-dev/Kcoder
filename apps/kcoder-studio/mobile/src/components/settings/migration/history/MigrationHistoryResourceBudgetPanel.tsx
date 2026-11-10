import type { MobileMigrationClient } from '@/runtime/migration-client';
export type HistoryBudgetProps = { client: MobileMigrationClient; jobId: string; cancelled: boolean };
/** Native platform interaction is deferred; the Web controller is implemented in the sibling. */
export function MigrationHistoryResourceBudgetPanel(_props: HistoryBudgetProps) { return null; }

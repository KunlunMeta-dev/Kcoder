import type { BudgetHistoryRow, ExpiredBudgetObservation } from './migrationResourceBudgetInvalidation.mjs'
import type { MigrationResourceBudgetReadParams, MigrationResourceBudgetView, MigrationResourceIncreaseParams,
  MigrationResourceIncreaseReceipt, MigrationResourceLimitFacts } from './generated/contracts'
export interface ResourceBudgetState {
  busy: boolean; error: string | null; view: MigrationResourceBudgetView | null;
  pending: (MigrationResourceIncreaseParams & { limits: MigrationResourceLimitFacts; confirm: true }) | null;
  receipt: MigrationResourceIncreaseReceipt | null; checked: boolean; recoveryBlocked: boolean;
  history: string[]; historyRows: BudgetHistoryRow[]; expiredObservation: ExpiredBudgetObservation | null; inspectedRequestId: string | null;
}
export function createResourceBudgetController(options: {
  api: { read(input: MigrationResourceBudgetReadParams, options?: { signal?: AbortSignal }): Promise<MigrationResourceBudgetView>;
    increase(input: MigrationResourceIncreaseParams): Promise<MigrationResourceIncreaseReceipt> };
  storage: { getItem(key: string): string | null; refresh(key: string): Promise<unknown>; withTransaction<T>(key: string, operation: (local: { getItem(key: string): string | null; setItem(key: string, value: string): void }) => T): Promise<T>; close?(): void }; scope: string; jobId: string; planId?: string | null;
  canIncrease?(): boolean; isCurrent(): boolean; createRequestId(): string; validIntent(value: unknown): boolean; validView(query: unknown, view: unknown): boolean;
}): {
  getSnapshot(): ResourceBudgetState; subscribe(listener: () => void): () => void; activate(): void; dispose(): void;
  read(requestId?: string): Promise<void>; increase(limits: MigrationResourceLimitFacts, expectedPolicyRevision: number, confirmed: boolean): Promise<void>;
  resubmit(confirmed: boolean): Promise<void>; acknowledge(): Promise<void>; archiveExpired(confirmed: boolean): Promise<void>;
};

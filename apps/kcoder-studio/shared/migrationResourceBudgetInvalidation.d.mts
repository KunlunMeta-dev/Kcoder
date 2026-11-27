import type { MigrationResourceBudgetReadParams, MigrationResourceBudgetView, MigrationResourceIncreaseParams, MigrationResourceLimitFacts } from './generated/contracts'
export type BudgetIntent = MigrationResourceIncreaseParams & { confirm: true; limits: MigrationResourceLimitFacts }
type ActiveView = Extract<MigrationResourceBudgetView, { phase: 'active' }>
export interface ExpiredBudgetObservation {
  query: MigrationResourceBudgetReadParams & { requestId: string };
  view: ActiveView;
}
export type BudgetHistoryRow = { kind: 'acknowledged'; requestId: string } | {
  kind: 'expired'; requestId: string; intent: BudgetIntent;
  observation: ExpiredBudgetObservation;
}
export function expiredBudgetObservation(intent: BudgetIntent | null, query: MigrationResourceBudgetReadParams, view: MigrationResourceBudgetView): ExpiredBudgetObservation | null;
export function expiredBudgetHistoryRow(intent: BudgetIntent, query: MigrationResourceBudgetReadParams, view: MigrationResourceBudgetView, validView: (query: unknown, view: unknown) => boolean): Extract<BudgetHistoryRow, { kind: 'expired' }> | null;
export function normalizeBudgetCache(value: unknown, options: { jobId: string; validIntent(value: unknown): boolean; validView(query: unknown, view: unknown): boolean }): { version: 2; pending: BudgetIntent | null; history: BudgetHistoryRow[] } | null;

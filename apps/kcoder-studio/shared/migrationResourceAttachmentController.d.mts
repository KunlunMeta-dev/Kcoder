import type { AttachmentIntent, AttachmentKind } from './migrationResourceAttachment'
import type { MigrationHistoryResourceAttachmentResult, MigrationResourceLimits } from './generated/contracts'
import type { BudgetSelectorStorage } from './migrationResourceBudgetStorage.mjs'
type View = MigrationHistoryResourceAttachmentResult
export interface AttachmentState { busy: boolean; view: View | null; pending: AttachmentIntent | null; error: string | null; checked: boolean; recoveryBlocked: boolean }
export function createResourceAttachmentController(options: {
  api: { read(input: { jobId: string }): Promise<View>; attach(input: AttachmentIntent): Promise<unknown> };
  storage: { getItem(key: string): string | null; refresh(key: string): Promise<unknown>; withTransaction<T>(key: string, action: (local: BudgetSelectorStorage) => T): Promise<T>; close?(): void };
  scope: string; kind: AttachmentKind; jobId: string; isCurrent(): boolean;
  validView(input: unknown, view: unknown): boolean; validIntent(intent: unknown): boolean;
}): { getSnapshot(): AttachmentState; subscribe(callback: () => void): () => void; activate(): void; dispose(): void; read(): Promise<void>; bind(limits: MigrationResourceLimits, confirmed: boolean): Promise<void>; resume(confirmed: boolean): Promise<void> }

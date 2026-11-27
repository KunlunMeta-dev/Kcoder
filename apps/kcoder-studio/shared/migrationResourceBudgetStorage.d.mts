export interface BudgetSelectorStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function createResourceBudgetStorage(options: { storage: Pick<Storage, 'getItem'>; indexedDB?: IDBFactory; isCurrent(): boolean }): {
  getItem(key: string): string | null;
  refresh(key: string): Promise<string | null>;
  withTransaction<T>(key: string, operation: (local: BudgetSelectorStorage) => T): Promise<T>;
  close(): void;
};

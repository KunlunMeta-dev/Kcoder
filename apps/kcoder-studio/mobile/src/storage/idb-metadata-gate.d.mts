export interface MetadataLease {
  readonly key: string;
  assert(): void;
  onRevoke(callback: () => void): () => void;
  effect<T>(operation: () => T): Promise<T>;
}
export function createIndexedMetadataGate(options?: { indexedDB?: IDBFactory; webLocks?: LockManager }): {
  run<T>(key: string, operation: (lease: MetadataLease) => T | Promise<T>, options?: { parent?: MetadataLease; signal?: AbortSignal }): Promise<T>;
};

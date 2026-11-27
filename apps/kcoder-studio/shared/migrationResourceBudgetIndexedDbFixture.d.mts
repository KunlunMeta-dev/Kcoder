/** Event fixture only; actual IndexedDB behavior is covered by registered Web acceptance. */
export function budgetIndexedDbFixture(): { indexedDB: IDBFactory; rows: Map<string, { raw: string; legacyRaw: string | null }>; modes: string[]; closes(): number };

const values = new Map<string, string>();

// Keep workspace-preferences on its real persistence path in Node runtime tests.
export const taskRuntimeAsyncStorage = {
  getItem: async (key: string): Promise<string | null> => values.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    values.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    values.delete(key);
  },
  getAllKeys: async (): Promise<string[]> => [...values.keys()],
  multiRemove: async (keys: readonly string[]): Promise<void> => {
    for (const key of keys) values.delete(key);
  },
};

export function resetTaskRuntimeAsyncStorage(): void {
  values.clear();
}

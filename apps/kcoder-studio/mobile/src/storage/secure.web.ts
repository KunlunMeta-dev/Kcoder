export async function getSecureValue(key: string): Promise<string | null> {
  return globalThis.localStorage?.getItem(key) ?? null;
}

export async function setSecureValue(key: string, value: string): Promise<void> {
  globalThis.localStorage?.setItem(key, value);
}

export async function deleteSecureValue(key: string): Promise<void> {
  globalThis.localStorage?.removeItem(key);
}

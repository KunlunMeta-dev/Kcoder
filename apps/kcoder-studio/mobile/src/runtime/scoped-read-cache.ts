const caches = new Set<{ clear(): void }>();
export function clearScopedReadCaches(): void { for (const cache of caches) cache.clear(); }
/** Bounded device-local read projection. Callers own cancellation; the last waiter cancels the shared transport. */
export class ScopedReadCache<T> {
  private readonly entries = new Map<string, { value?: T; expiresAt: number; promise?: Promise<T>; controller: AbortController; waiters: number }>();
  constructor(private readonly maximum = 32, private readonly ttlMs = 30_000) { caches.add(this); }
  clear(matches: (key: string) => boolean = () => true): void {
    for (const [key, entry] of this.entries) if (matches(key)) { this.entries.delete(key); entry.controller.abort(); }
  }
  get(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("读取已取消"));
    let entry = this.entries.get(key);
    if (entry?.value !== undefined && entry.expiresAt > Date.now()) {
      this.entries.delete(key); this.entries.set(key, entry);
      return Promise.resolve(entry.value);
    }
    if (!entry?.promise) {
      if (entry) this.entries.delete(key);
      for (const [oldKey, old] of this.entries) {
        if (this.entries.size < this.maximum) break;
        if (!old.promise) this.entries.delete(oldKey);
      }
      if (this.entries.size >= this.maximum) return Promise.reject(new Error("读取缓存准入已满，请稍后重试"));
      entry = { expiresAt: 0, controller: new AbortController(), waiters: 0 };
      const owned = entry;
      this.entries.set(key, owned);
      owned.promise = Promise.resolve().then(() => load(owned.controller.signal)).then((value) => {
        if (this.entries.get(key) === owned && !owned.controller.signal.aborted) { owned.value = value; owned.expiresAt = Date.now() + this.ttlMs; }
        return value;
      }).finally(() => { owned.promise = undefined; if (owned.value === undefined && this.entries.get(key) === owned) this.entries.delete(key); });
    }
    const owned = entry;
    const pending = owned.promise!;
    owned.waiters++;
    return new Promise<T>((resolve, reject) => {
      let complete = false;
      const finish = () => { if (complete) return false; complete = true; signal?.removeEventListener("abort", abort); owned.controller.signal.removeEventListener("abort", abort); owned.waiters--; return true; };
      const abort = () => {
        if (!finish()) return;
        if (!owned.waiters) { if (this.entries.get(key) === owned) this.entries.delete(key); owned.controller.abort(); }
        reject(new Error("读取已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      owned.controller.signal.addEventListener("abort", abort, { once: true });
      pending.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    });
  }
}

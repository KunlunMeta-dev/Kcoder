import { afterEach, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";

/** A real metadata fence and FIFO lock over owned synthetic browser storage. */
export function installBrowserProfileFixture(profiles: GatewayProfile[] = []) {
  const values = new Map<string, string>();
  values.set("kcoder-studio-mobile.gateway-profiles.v2", JSON.stringify({
    profiles: profiles.map(({ id, baseUrl, authorizationGeneration, deviceId }) => ({
      id, baseUrl, authorizationGeneration, deviceId,
    })),
  }));
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: {
    request: async <T>(key: string, _options: unknown, operation: () => Promise<T>) => {
      const previous = tails.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      tails.set(key, current);
      try { return await current; }
      finally { if (tails.get(key) === current) tails.delete(key); }
    },
  } });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { localStorage });
  return { values, localStorage };
}

afterEach(() => vi.unstubAllGlobals());

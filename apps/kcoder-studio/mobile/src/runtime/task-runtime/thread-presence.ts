import { isThreadPresenceReadResultV1, type ThreadPresenceReadResultV1 } from "../../../../shared/generated/contracts";
import type { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "@/storage/session-transcript-scope";
import type { SessionTranscriptRecordVersion } from "@/storage/session-transcript-store";

export const THREAD_PRESENCE_READ_CAPABILITY = "threadPresenceReadV1";
export const THREAD_PRESENCE_READ_TIMEOUT_MS = 2_000;
export const THREAD_PRESENCE_PHASE_DEADLINE_MS = 2_500;

export interface ThreadPresenceObservation {
  result: ThreadPresenceReadResultV1;
  scope: SessionTranscriptScope | null;
  version: SessionTranscriptRecordVersion | null;
}

export interface ThreadPresenceProbeInput {
  client: GatewayRpcClient;
  profile: GatewayProfile;
  server: KCoderServer;
  cwd?: string;
  threadId: string;
  ownerToken: object;
  isCurrentOwner: () => boolean;
}

type ProbeCache = typeof sessionTranscriptCache;
const flights = new WeakMap<GatewayRpcClient, WeakMap<object, Map<string, Promise<ThreadPresenceObservation | null>>>>();

function parseThreadPresence(value: unknown, expectedThreadId: string): ThreadPresenceReadResultV1 | null {
  return isThreadPresenceReadResultV1(value) && value.threadId === expectedThreadId ? value : null;
}

function exactOwner(input: ThreadPresenceProbeInput, isActive: () => boolean = () => true): boolean {
  return isActive() && input.isCurrentOwner() && input.client.matchesRetainedAttachmentOwner(input.profile, input.server, input.cwd);
}

async function readWitness(input: ThreadPresenceProbeInput, cache: ProbeCache, isActive: () => boolean) {
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || !exactOwner(input, isActive)) return { scope: null, version: null };
  let scope: SessionTranscriptScope;
  try { scope = captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId); }
  catch { return { scope: null, version: null }; }
  try {
    const lease = await cache.capture(scope, () => exactOwner(input, isActive));
    if (!exactOwner(input, isActive)) return { scope: null, version: null };
    const loaded = await cache.loadVersioned(lease);
    if (!exactOwner(input, isActive)) return { scope: null, version: null };
    if (!loaded || sessionTranscriptScopeKey(loaded.value.record.scope) !== sessionTranscriptScopeKey(scope))
      return { scope, version: null };
    return { scope, version: loaded.version };
  } catch {
    if (!exactOwner(input, isActive))
      return { scope: null, version: null };
    return { scope, version: null };
  }
}

export async function probeThreadPresence(
  input: ThreadPresenceProbeInput,
  cache: ProbeCache = sessionTranscriptCache,
): Promise<ThreadPresenceObservation | null> {
  if (input.client.supportsExperimental(THREAD_PRESENCE_READ_CAPABILITY) !== true || !exactOwner(input)) return null;
  let ownerFlights = flights.get(input.client);
  if (!ownerFlights) { ownerFlights = new WeakMap(); flights.set(input.client, ownerFlights); }
  let scopeKey: string;
  try {
    scopeKey = input.cwd ? sessionTranscriptScopeKey(captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId)) : input.threadId;
  } catch { scopeKey = input.threadId; }
  let threadFlights = ownerFlights.get(input.ownerToken);
  if (!threadFlights) { threadFlights = new Map(); ownerFlights.set(input.ownerToken, threadFlights); }
  const existing = threadFlights.get(scopeKey);
  if (existing) return existing;
  const pending = (async (): Promise<ThreadPresenceObservation | null> => {
    let active = true;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const deadline = new Promise<null>(resolve => {
      deadlineTimer = setTimeout(() => { active = false; resolve(null); }, THREAD_PRESENCE_PHASE_DEADLINE_MS);
    });
    const operation = (async (): Promise<ThreadPresenceObservation | null> => {
      const witness = await readWitness(input, cache, () => active);
      if (!exactOwner(input, () => active)) return null;
      const remaining = THREAD_PRESENCE_PHASE_DEADLINE_MS - (Date.now() - startedAt);
      if (remaining <= 0) return null;
      try {
        const response = await input.client.request<unknown>("thread/presence/read", { threadId: input.threadId },
          Math.min(THREAD_PRESENCE_READ_TIMEOUT_MS, remaining));
        if (!exactOwner(input, () => active)) return null;
        const result = parseThreadPresence(response, input.threadId);
        return result ? { result, ...witness } : null;
      } catch {
        return null;
      }
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { active = false; if (deadlineTimer) clearTimeout(deadlineTimer); }
  })();
  threadFlights.set(scopeKey, pending);
  try { return await pending; }
  finally { if (threadFlights.get(scopeKey) === pending) threadFlights.delete(scopeKey); }
}

import type { GatewayProfile } from "@/gateway/types";
import { createSessionTranscriptBackend } from "./session-transcript-backend";
import { createSessionTranscriptStore } from "./session-transcript-store";

/** One platform cache; it owns no connections, runtime or pending-send state. */
export const sessionTranscriptCache = createSessionTranscriptStore(createSessionTranscriptBackend());

/** Cache restoration must respect the existing durable deletion ticket before presenting a route. */
export async function loadLastSessionTranscript(profile: GatewayProfile, isCurrent: () => boolean) {
  const value = await sessionTranscriptCache.last(profile, isCurrent);
  if (!isCurrent() || !value) return null;
  const { isSessionTranscriptDeletionPending } = await import("./thread-deletion-cleanup");
  if (await isSessionTranscriptDeletionPending(value.record.scope)) return null;
  return isCurrent() ? value : null;
}

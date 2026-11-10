import { useEffect, useMemo, useRef, useState } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { loadLastDraftProject, saveLastDraftProject, type LastDraftProject } from "@/storage/new-workspace-preferences";
import { workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { useFormOwner } from "../forms/form-owner";

export function draftProjectScope(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([workspaceStateAuthorizationScope(profile, server), profile.deviceId ?? null]);
}

export function useLastDraftProject(profile: GatewayProfile | null, servers: KCoderServer[], enabled: boolean) {
  const key = JSON.stringify([enabled, profile?.id, servers.map(server => [server.id, profile ? draftProjectScope(profile, server) : null])]);
  const owner = useFormOwner(key);
  const [result, setResult] = useState<{ owner: typeof owner; value: LastDraftProject | null }>();
  useEffect(() => {
    if (!enabled || !profile) return;
    let cancelled = false;
    const scopes = Object.fromEntries(servers.map(server => [server.id, draftProjectScope(profile, server)]));
    void loadLastDraftProject(profile.id, scopes).catch(() => null).then(value => {
      if (!cancelled && owner.isCurrent()) setResult({ owner, value });
    });
    return () => { cancelled = true; };
  }, [owner]);
  return useMemo(() => ({ ready: !enabled || result?.owner === owner, value: result?.owner === owner ? result.value : null }), [enabled, owner, result]);
}

/** Only an initialized, current target may become the next draft's default. */
export function useRememberDraftProject(profile: GatewayProfile | null, server: KCoderServer | undefined, cwd: string, enabled: boolean) {
  const scope = profile && server ? draftProjectScope(profile, server) : null;
  const key = JSON.stringify([profile?.id, scope, cwd.trim()]);
  const saved = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !profile || !server || !scope || !cwd.trim() || saved.current === key) return;
    let cancelled = false;
    void saveLastDraftProject(profile.id, { serverId: server.id, scope, cwd }).then(() => {
      if (!cancelled) saved.current = key;
    }).catch(() => { /* Optional preference persistence must not block a usable draft. */ });
    return () => { cancelled = true; };
  }, [key, enabled]);
}

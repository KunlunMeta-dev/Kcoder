import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/i18n";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { GatewayRpcClient } from "@/gateway/rpc";
import { taskClientConnector } from "@/runtime/task-runtime/connectionFactory";
import { catalogReadScopeKey } from "@/runtime/task-runtime/new-catalog-read-source";

/** An initialized workspace connection; opening a draft never starts a thread. */
export function useNewTaskDraftConnection(profile: GatewayProfile | null, server: KCoderServer | undefined, cwd: string, enabled: boolean) {
  const scope = profile && server && cwd ? JSON.stringify([catalogReadScopeKey(profile, server), server.observationTargetIdentity, cwd]) : null;
  const owner = useMemo(() => ({}), [scope, enabled]);
  const latest = useRef(owner);
  latest.current = owner;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ owner: object; client: GatewayRpcClient | null; error: string | null }>({ owner, client: null, error: null });
  useEffect(() => {
    if (!enabled || !profile || !server || !scope) return;
    const controller = new AbortController();
    let client: GatewayRpcClient | undefined;
    let unsubscribe: (() => void) | undefined;
    setState({ owner, client: null, error: null });
    void taskClientConnector(profile, server, cwd, "runtime", { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || latest.current !== owner) { value.close(); return; }
      client = value;
      setState({ owner, client, error: null });
      unsubscribe = value.subscribeClose(() => { if (!controller.signal.aborted && latest.current === owner) setState({ owner, client: null, error: t("task.disconnected") }); });
    }).catch(error => {
      if (!controller.signal.aborted && latest.current === owner) setState({ owner, client: null, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { controller.abort(); unsubscribe?.(); client?.close(); };
  }, [owner, revision]);
  const client = enabled && state.owner === owner && latest.current === owner ? state.client : null;
  return { client, owner, ready: Boolean(client), error: enabled && state.owner === owner ? state.error : null,
    supportsPermissions: client?.supportsExperimental("turnPermissions") === true,
    retry: () => setRevision(value => value + 1) };
}

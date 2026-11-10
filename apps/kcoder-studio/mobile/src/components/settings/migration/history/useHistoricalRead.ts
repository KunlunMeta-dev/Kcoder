import { useEffect, useState } from "react";
import { migrationError, type MigrationCalls, type MobileMigrationClient } from "@/runtime/migration-client";

/** Read windows belong to the selected account and exact immutable coordinates. */
export function useHistoricalRead<N extends keyof MigrationCalls>(client: MobileMigrationClient, name: N, params: MigrationCalls[N][0], enabled = true, revision = 0) {
  const key = JSON.stringify([name, params, revision]);
  const [state, setState] = useState<{ client: MobileMigrationClient; key: string; result: MigrationCalls[N][1] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !client.supports(name)) return;
    let live = true;
    void client.call(name, params).then(result => { if (live && client.available()) setState({ client, key, result, error: null }); }, error => { if (live && client.available()) setState({ client, key, result: null, error: migrationError(error) }); });
    return () => { live = false; };
  }, [client, key, enabled]);
  const current = enabled && state?.client === client && state.key === key ? state : null;
  return { result: current?.result ?? null, error: !client.supports(name) ? "migration_update_required" : current?.error ?? null, loading: enabled && current === null };
}

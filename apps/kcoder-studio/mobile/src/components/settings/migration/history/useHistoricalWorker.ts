import { useEffect, useMemo, useRef, useState } from "react";
import { migrationError, type MigrationCalls, type MobileMigrationClient } from "@/runtime/migration-client";
import { HISTORY_WORKER_STATE_CAPABILITY, historyWorkerObservation } from "@/runtime/migration-history-worker";

type ReadName = "historyRead" | "branchRead" | "toolsRead" | "attachmentRead" | "toolAttachmentRead" | "localRead" | "continuationRead" | "undoRead" | "uploadCollectionRead" | "retirementRead";
function sequence(value: any): number | null { const found = value?.retirement?.sequence ?? value?.collection?.sequence ?? value?.upload?.sequence ?? value?.job?.sequence ?? value?.progress?.sequence ?? value?.state?.run?.sequence; return Number.isSafeInteger(found) ? found : null; }
function cancelRevision(value: any): number | null { const found = value?.retirement?.cancelRevision ?? value?.collection?.cancelRevision ?? value?.upload?.cancelRevision ?? value?.job?.cancelRevision; return Number.isSafeInteger(found) ? found : null; }
function running(value: any): boolean { return value?.workerState === 'running' || value?.workerScheduled === true || value?.workerRunning === true || value?.state?.workerRunning === true; }
function interpretation(value: any): string | undefined { return value?.retirement?.operationId ?? value?.collection?.operationId ?? value?.choice?.viewId ?? value?.progress?.viewId ?? value?.state?.viewId ?? value?.upload?.operationId ?? value?.job?.jobId ?? value?.job?.id; }
/** Read polling is page-owned. Mutations are explicit, single-dispatch and retain Native receipts. */
export function useHistoricalWorker<N extends ReadName>(client: MobileMigrationClient, name: N, params: MigrationCalls[N][0], enabled = true) {
  type Result = MigrationCalls[N][1];
  const key = JSON.stringify(params);
  const scope = useMemo(() => ({ client, name, key }), [client, name, key]);
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  const latest = useRef<{ scope: typeof scope; result: Result } | null>(null);
  const active = useRef<typeof scope | null>(null);
  const epoch = useRef(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ scope: typeof scope; result: Result | null; error: string | null; busy: boolean }>({ scope, result: null, error: null, busy: false });
  const valid = () => mounted.current && current.current === scope && client.available();
  const accept = (value: Result) => {
    if (!valid()) return;
    const before = latest.current?.scope === scope ? latest.current.result : null;
    if(name==='retirementRead') {
      const old=(before as any)?.retirement,next=(value as any)?.retirement;
      if(old&&next&&old.operationId===next.operationId&&(next.cancelRevision<old.cancelRevision||next.collectedBytes<old.collectedBytes||old.logicalRetired&&!next.logicalRetired))return;
    }
    const a = sequence(before), b = sequence(value), ca = cancelRevision(before), cb = cancelRevision(value);
    if (interpretation(before) === interpretation(value) && (a !== null && b !== null && b < a || a === b && ca !== null && cb !== null && cb < ca)) return;
    latest.current = { scope, result: value };
    setState(old => ({ ...(old.scope === scope ? old : { result: null, busy: false, error: null }), scope, result: value, error: null }));
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const ticket = epoch.current;
    let retries = 0;
    let observedSequence: number | null = null, quietDelay = 600;
    async function read() {
      try {
        const result = await client.call(name, params);
        if (!live || !valid() || ticket !== epoch.current) return;
        accept(result); retries = 0;
        if (latest.current?.scope === scope) {
          const observed = latest.current.result, watermark = sequence(observed);
          if (running(observed)) { observedSequence = watermark; quietDelay = 600; timer = setTimeout(() => { void read(); }, 600); }
          else if (name === "historyRead" && historyWorkerObservation(observed as MigrationCalls["historyRead"][1], client.supportsCapability?.(HISTORY_WORKER_STATE_CAPABILITY) === true) !== "stopped" && ["capturing", "archiving", "normalizing"].includes((observed as any)?.job?.stage)) {
            // A parent batch or another coordinator can advance this durable job without owning this worker map.
            quietDelay = watermark === observedSequence ? Math.min(5000, quietDelay * 2) : 600;
            observedSequence = watermark; timer = setTimeout(() => { void read(); }, quietDelay);
          }
        }
      } catch (error) {
        if (!live || !valid() || ticket !== epoch.current) return;
        const code = migrationError(error);
        if (["local_upload_collection_busy", "local_upload_busy", "history_catalog_busy", "migration_busy", "continuation_busy", "historical_undo_busy"].includes(code) && retries++ < 8) timer = setTimeout(() => { void read(); }, 250);
        else setState(old => ({ ...(old.scope === scope ? old : { result: null, busy: false }), scope, error: code }));
      }
    }
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [scope, enabled, revision]);
  async function perform(operation: () => Promise<Result>) {
    if (!valid() || active.current === scope) return false;
    active.current = scope; epoch.current++;
    setState(old => ({ ...(old.scope === scope ? old : { result: null }), scope, busy: true, error: null }));
    try { const result = await operation(); if (valid()) accept(result); return valid(); }
    catch (error) { if (valid()) setState(old => ({ ...old, scope, error: migrationError(error) })); return false; }
    finally {
      if (active.current === scope) active.current = null;
      if (valid()) { setState(old => ({ ...old, busy: false })); setRevision(value => value + 1); }
    }
  }
  const visible = state.scope === scope ? state : null;
  return { result: visible?.result ?? null, busy: visible?.busy ?? false, error: visible?.error ?? null, perform, refresh: () => setRevision(value => value + 1), current: () => latest.current?.scope === scope ? latest.current.result : null, valid };
}

import { metadataStorage, type MetadataAuthority } from "./metadata-authority";
import type { GatewayProfile } from "@/gateway/types";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileMetadata } from "./workspace-profile-fence";
import { isMigrationHistoryAttachmentParams, type HistoricalAttachmentSelection } from "../../../shared/generated/contracts";
import { isMigrationMemoryControlParams, type MigrationMemoryControlParams } from "../../../shared/generated/contracts";

export interface MigrationIntent {
  id: string;
  method: string;
  createdAt: number;
  phase: "intent" | "unknown" | "acknowledged" | "reviewed";
  requestId?: string;
  jobId?: string;
  planId?: string;
  operationId?: string;
  sequence?: number;
  familyDigest?: string;
  viewId?: string;
  sourceJobId?: string;
  continuationJobId?: string;
  selection?: HistoricalAttachmentSelection;
  memoryControl?: MigrationMemoryControlParams;
}
export interface MigrationIntentStore {
  read(): Promise<MigrationIntent[]>;
  put(value: MigrationIntent): Promise<void>;
  reserveFamily?(value: MigrationIntent): Promise<MigrationIntent>;
}
/** Only public receipt locators are retained, never source code, credentials or RPC bodies. */
export function migrationIntentStore(profile: GatewayProfile, scope: string, current: () => boolean): MigrationIntentStore {
  const authorization = captureWorkspaceProfileIdentity(profile);
  const key = "kcoder-studio:migration-intents:v1:" + encodeURIComponent(scope);
  const check = () => { if (!current()) throw new Error("migration_scope_changed"); };
  async function readInsideGate(authority?: MetadataAuthority): Promise<MigrationIntent[]> {
    check();
    const raw = await metadataStorage(authority, check).getItem(key);
    check();
    if (!raw) return [];
    if (raw.length > 128 * 1024) throw new Error("migration_recovery_record_invalid");
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 64 || rows.some(row => !valid(row))) throw new Error("migration_recovery_record_invalid");
    return rows as MigrationIntent[];
  }
  async function putInsideGate(value: MigrationIntent, authority?: MetadataAuthority) {
      check();
      if (!valid(value)) throw new Error("migration_recovery_record_invalid");
      const rows = await readInsideGate(authority);
      const index = rows.findIndex(row => row.id === value.id);
      if (index >= 0) {
        const old = rows[index];
        for (const field of ["method", "requestId", "planId", "createdAt", "familyDigest", "viewId", "sourceJobId", "continuationJobId"] as const)
          if (old[field] !== value[field]) throw new Error("migration_recovery_identity_changed");
        if (JSON.stringify(old.selection) !== JSON.stringify(value.selection)) throw new Error("migration_recovery_identity_changed");
        if (JSON.stringify(old.memoryControl) !== JSON.stringify(value.memoryControl)) throw new Error("migration_recovery_identity_changed");
        if (old.phase === "acknowledged" && value.phase !== "acknowledged") return;
        rows[index] = value;
      } else {
        if (rows.length >= 64) {
          const settled = rows.findIndex(row => row.phase === "acknowledged" || row.phase === "reviewed");
          if (settled < 0) throw new Error("migration_recovery_records_full");
          rows.splice(settled, 1);
        }
        rows.push(value);
      }
      check();
      await metadataStorage(authority, check).setItem(key, JSON.stringify(rows));
      check();
  }
  return {
    read: () => withWorkspaceProfileMetadata(authorization, readInsideGate),
    put: value => withWorkspaceProfileMetadata(authorization, authority => putInsideGate(value, authority)),
    reserveFamily: value => withWorkspaceProfileMetadata(authorization, async authority => {
      if (!valid(value) || !value.familyDigest || value.method !== "migration/history/continuation/create") throw new Error("migration_recovery_record_invalid");
      const rows = await readInsideGate(authority);
      const found = rows.find(row => row.method === value.method && row.familyDigest === value.familyDigest && row.sourceJobId === value.sourceJobId && row.viewId === value.viewId);
      if (found) return found;
      await putInsideGate(value, authority); return value;
    }),
  };
}
function valid(value: unknown): value is MigrationIntent {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const keys = new Set(["id", "method", "createdAt", "phase", "requestId", "jobId", "planId", "operationId", "sequence", "familyDigest", "viewId", "sourceJobId", "continuationJobId", "selection", "memoryControl"]);
  return Object.keys(row).every(key => keys.has(key)) && typeof row.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(row.id)
    && typeof row.method === "string" && /^migration\/[a-z/-]+$/.test(row.method)
    && Number.isSafeInteger(row.createdAt) && ["intent", "unknown", "acknowledged", "reviewed"].includes(String(row.phase))
    && ["requestId", "jobId", "planId", "operationId"].every(key => row[key] === undefined || typeof row[key] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(row[key] as string))
    && ["viewId", "sourceJobId", "continuationJobId"].every(key => row[key] === undefined || typeof row[key] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(row[key] as string))
    && (row.familyDigest === undefined || typeof row.familyDigest === "string" && /^[a-f0-9]{64}$/.test(row.familyDigest))
    && (row.selection === undefined || isMigrationHistoryAttachmentParams({ selection: row.selection }))
    && (row.memoryControl === undefined || row.method === 'migration/memory/control' && isMigrationMemoryControlParams(row.memoryControl)
      && row.memoryControl.requestId === row.requestId && row.id === row.requestId && JSON.stringify(row.memoryControl).length <= 4096)
    && (row.sequence === undefined || Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0);
}

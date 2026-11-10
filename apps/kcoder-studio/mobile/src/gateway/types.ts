import type { ProviderFailureDetails } from '../../../shared/providerFailure';
import type { ThreadRunSummary } from '../../../shared/threadRunSummary';
import type { GatewayConnectionRoutes } from '../../../shared/gatewayConnectionRoutes.js';
import type { GatewayServerCapabilities } from "./rpc";
export interface GatewayProfile {
  id: string;
  label: string;
  baseUrl: string;
  accessToken: string;
  expiresAt: number;
  rpcToken: string;
  /** Non-secret authorization family identity; stable across access-token refresh. */
  authorizationGeneration?: string;
  /** Non-secret signed LAN/public route descriptor for this Gateway. */
  connectionRoutes?: GatewayConnectionRoutes;
  authMode?: "device" | "legacy";
  deviceId?: string;
  refreshExpiresAt?: number;
  accessTtlMs?: number;
  refreshToken?: string;
  pendingRotationId?: string;
  /** Non-secret profile scope denied by an authenticated Gateway 401. */
  reauthorizationRequiredScope?: string;
}

/** Ephemeral in-memory evidence for the exact grant that received HTTP 401. Never persist or log. */
export interface GatewayAuthorizationDenialWitness {
  profileId: string;
  baseUrl: string;
  authMode?: "device" | "legacy";
  authorizationGeneration?: string;
  deviceId?: string;
  accessToken: string;
  refreshToken?: string;
}

export interface KCoderServer {
  id: string;
  label: string;
  labelKey?: "currentComputer";
  description: string;
  runtime: "kcoder";
  transport: "local" | "ssh";
  /** Opaque, non-secret Gateway target revision for cwd observation preconditions. */
  observationTargetIdentity?: string;
  workspacePath?: string;
  host?: string;
  user?: string;
  port?: number;
  command?: string;
  profile?: string;
  settingsFile?: string;
  accountIdentity?: { principalId: string; username: string; role?: string };
  chromiumBin?: string;
  chromiumNoSandbox?: boolean;
  acceptNewHostKey?: boolean;
  capabilities?: Record<string, boolean>;
}

export interface KCoderServerDraft {
  id: string;
  label: string;
  description?: string;
  runtime: "kcoder";
  transport: "ssh";
  host: string;
  user?: string;
  port?: number;
  command?: string;
  workspace?: string;
  profile?: string;
  settingsFile?: string;
  accountIdentity?: { principalId: string; username: string; role?: string };
  chromiumBin?: string;
  chromiumNoSandbox?: boolean;
  acceptNewHostKey?: boolean;
}

export interface ServerStatus {
  id: string;
  status: "online" | "offline" | "checking";
  latencyMs?: number;
  checkedAt?: number;
  error?: string;
  /** Version reported by serverInfo.version in the app-server initialize result. */
  appServerVersion?: string | null;
  /** Protocol selected in the app-server initialize result. */
  protocolVersion?: string | null;
  capabilities?: GatewayServerCapabilities;
}

export interface ThreadSummary {
  sessionMode?: 'default' | 'orchestrate';
  id: string;
  status: "idle" | "running" | "waiting_for_approval" | "waiting_for_answer" | "background" | "aggregating" | "unknown" | "failed";
  runSummary?: ThreadRunSummary;
  title?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  model_provider?: string;
  providerId?: string;
  archivedAt?: string;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface ThreadMessage {
  fileChangesCapture?: unknown;
  reviewEvidence?: unknown;
  attemptId?: string;
  continuedByAttemptId?: string;
  error?: string;
  errorType?: string;
  providerFailure?: ProviderFailureDetails;
  id: string;
  turnId?: string;
  role: "user" | "assistant" | "system" | string;
  content: string;
  status?: string;
  blocks?: unknown[];
  timestampMs: number;
}

// Mobile shares the generated recovery wire contract; it currently has no Wiki UI.
export type { WikiImageImport, KnowledgeImageImportListResult } from '../../../shared/generated/contracts';

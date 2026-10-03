import type { ProviderFailureDetails } from '../../../shared/providerFailure';
import type { ThreadRunSummary } from '../../../shared/threadRunSummary';
export interface GatewayProfile {
  id: string;
  label: string;
  baseUrl: string;
  accessToken: string;
  expiresAt: number;
  rpcToken: string;
}

export interface KCoderServer {
  id: string;
  label: string;
  description: string;
  runtime: "kcoder";
  transport: "local" | "ssh";
  workspacePath?: string;
  host?: string;
  user?: string;
  port?: number;
  command?: string;
  profile?: string;
  settingsFile?: string;
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

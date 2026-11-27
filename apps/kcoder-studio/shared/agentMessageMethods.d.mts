export const AGENT_MESSAGE_METHODS: Readonly<{ targets: 'thread/agentMessage/targets'; send: 'thread/agentMessage/send'; get: 'thread/agentMessage/get'; listReceipts: 'thread/agentMessage/receipts/list'; resolve: 'thread/agentMessage/resolve'; policyRead: 'thread/agentMessage/policy/read'; policySave: 'thread/agentMessage/policy/save' }>;
export const AGENT_MESSAGE_CAPABILITIES: readonly string[];
export const AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY: 'crossSessionDiscoverySearchV1';
export const AGENT_MESSAGE_RECEIPTS_CAPABILITY: 'crossSessionMessageReceiptsV1';
export const AGENT_MESSAGE_REPLIES_CAPABILITY: 'crossSessionMessageRepliesV1';
export const AGENT_MESSAGE_RECEIPT_FILTER_FIELDS: readonly string[];
export const AGENT_MESSAGE_RECEIPT_QUERY_FIELDS: readonly string[];
export interface AgentMessageReceiptQuery { targetThreadId?: string | null; status?: 'queued' | 'delivering' | 'applied' | 'rejected' | 'expired' | 'unknown' | null; createdAfterMs?: number | null; createdBeforeMs?: number | null; limit?: number | null; cursor?: string | null; }
export function agentMessageReceiptQuery(value: unknown): Record<string, unknown>;
export function validAgentMessageReceiptQuery(value: unknown): value is AgentMessageReceiptQuery;
export function validAgentMessageReceiptList(value: unknown, sourceThreadId?: string): boolean;
export const AGENT_MESSAGE_TARGET_FILTER_FIELDS: readonly string[];
export const AGENT_MESSAGE_TARGET_QUERY_FIELDS: readonly string[];
export interface AgentMessageTargetQuery {
  title?: string | null; query?: string | null; targetId?: string | null;
  status?: 'idle' | 'running' | 'waiting_for_approval' | 'waiting_for_answer' | 'failed' | 'background' | 'aggregating' | 'unknown' | null;
  presence?: 'resident' | 'not_resident' | 'unknown' | null; limit?: number | null; cursor?: string | null;
  allowedMode?: 'enqueue_only' | 'wake_if_idle' | null;
}
export function validAgentMessageTargetQuery(value: unknown): value is AgentMessageTargetQuery;
export function agentMessageTargetQuery(value: unknown): Record<string, unknown>;
export function agentMessageDiscoveryRequiresSearch(value: unknown): boolean;
export function agentMessageDiscoveryErrorData(error: unknown): { reason: 'cursor_invalid' | 'cursor_filter_mismatch' | 'search_unsupported' } | undefined;
export function agentMessageReceiptErrorData(error: unknown): { reason: 'cursor_invalid' | 'cursor_filter_mismatch' | 'receipts_unsupported' } | undefined;
export function agentMessageMethod(method: unknown): boolean;
export function agentMessageCapability(method: string): 'crossSessionDiscoveryV1' | 'crossSessionMessagesV1' | 'crossSessionMessageReceiptsV1';
export function agentMessageId(value: unknown): value is string;
export function validAgentTurnId(value: unknown): value is string;
export function agentMessageUtf8Bytes(value: string): number;
export function validAgentMessageAddress(value: unknown): value is import('./peerAgentMessage').SessionAddress;
export function validAgentMessageTargetSelector(value: unknown): boolean;
export function validAgentMessagePolicy(value: unknown): value is { enabled: boolean; wakeIdle: boolean; revision: string };
export function validAgentMessageResolvedAddress(value: unknown): value is { serverId: string; workspacePath: string; threadId: string; address: import('./peerAgentMessage').SessionAddress };
export function validAgentMessageRequest(method: string, value: unknown): boolean;
export function validAgentMessageReceipt(value: unknown): value is import('./generated/contracts').CrossSessionMessageReceipt;

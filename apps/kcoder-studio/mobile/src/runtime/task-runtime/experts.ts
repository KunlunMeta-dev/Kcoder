import type {
  AgentDefinitionRef,
  IntegrationRequest,
  IntegrationScope,
  OfficeAssistantDefinition,
  OfficeAssistantVersion,
  OfficeSettingsReadResult,
  ThreadExpertResult,
} from "../../../../shared/generated/contracts";
import {
  isIntegrationReply,
  isIntegrationScope,
  isOfficeAssistantVersion,
  isThreadExpertResult,
} from "../../../../shared/generated/contractGuards.mjs";
import { isContract } from "../../../../shared/generated/validator.mjs";
import { encodePeerUtf8 } from "@/gateway/peer-transport-bytes";
import type { GatewayRpcClient } from "@/gateway/rpc";
import type { TaskRuntime } from "./core";

const THREAD_EXPERT_CAPABILITIES = ["agentDefinitionsV1", "agentTurnConfigurationV1"] as const;
const CATALOG_CAPABILITIES = ["integrationScopeV1", "officeWorkspaceV1"] as const;
const PAGE_SIZE = 10;
let nextRequestId = 0;

export interface ExpertChoice {
  reference: AgentDefinitionRef;
  title: string;
  description?: string;
}

export interface ExpertDirectoryItem {
  id: string;
  title: string;
  description?: string;
}

export interface ExpertDirectoryPage {
  items: ExpertDirectoryItem[];
  nextCursor: string | null;
}

export interface ExpertVersionPage {
  items: ExpertChoice[];
  nextCursor: string | null;
}

export type ExpertCatalogClient = Pick<GatewayRpcClient, "request" | "supportsExperimental">;
type RuntimeOwner = {
  client: GatewayRpcClient;
  context: NonNullable<TaskRuntime["reconnectContext"]>;
  generation: number;
  threadId: string;
  cwd: string;
  runtimeInstanceNonce: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function validReferencePart(value: string): boolean {
  return value.length > 0 && encodePeerUtf8(value).length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validReference(reference: AgentDefinitionRef): boolean {
  return validReferencePart(reference.id) && validReferencePart(reference.version) &&
    /^[a-f0-9]{64}$/.test(reference.definitionSha256);
}

function currentOwner(runtime: TaskRuntime, signal?: AbortSignal): RuntimeOwner {
  throwIfAborted(signal);
  const context = runtime.reconnectContext;
  const client = runtime.client;
  const threadId = runtime.snapshot.threadId;
  const cwd = runtime.snapshot.cwd;
  if (runtime.disposed || !runtime.snapshot.connected || !client || !threadId)
    throw new Error("AGENT_ORIGINAL_TASK_REQUIRED");
  if (!context || !client.matchesRuntimeOwner(context.profile, context.server, cwd))
    throw new Error("AGENT_ORIGINAL_TASK_CHANGED");
  return {
    client,
    context,
    generation: runtime.clientGeneration,
    threadId,
    cwd,
    runtimeInstanceNonce: runtime.runtimeInstanceNonce,
  };
}

function assertCurrent(runtime: TaskRuntime, owner: RuntimeOwner, signal?: AbortSignal): void {
  throwIfAborted(signal);
  if (runtime.disposed || runtime.runtimeInstanceNonce !== owner.runtimeInstanceNonce ||
      runtime.client !== owner.client || runtime.clientGeneration !== owner.generation ||
      runtime.reconnectContext !== owner.context || runtime.snapshot.threadId !== owner.threadId ||
      runtime.snapshot.cwd !== owner.cwd || !runtime.snapshot.connected ||
      !owner.client.matchesRuntimeOwner(owner.context.profile, owner.context.server, owner.cwd))
    throw new Error("AGENT_ORIGINAL_TASK_CHANGED");
}

function taskSupportsExperts(client: GatewayRpcClient): boolean {
  return THREAD_EXPERT_CAPABILITIES.every(capability => client.supportsExperimental(capability));
}

function requireThreadExpertSupport(client: GatewayRpcClient): void {
  if (!THREAD_EXPERT_CAPABILITIES.every(capability => client.supportsExperimental(capability)))
    throw new Error("AGENT_TURN_CONFIGURATION_UNSUPPORTED");
}

function requireOfficeSettingsSupport(client: ExpertCatalogClient): void {
  if (!client.supportsExperimental("officeSettingsV1"))
    throw new Error("AGENT_EXPERTS_UNSUPPORTED");
}

function requireCatalogSupport(client: ExpertCatalogClient): void {
  if (!CATALOG_CAPABILITIES.every(capability => client.supportsExperimental(capability)))
    throw new Error("AGENT_EXPERTS_UNSUPPORTED");
}

async function requestRead<T>(
  client: ExpertCatalogClient,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  throwIfAborted(signal);
  const result = await client.request<T>(method, params, timeoutMs);
  throwIfAborted(signal);
  return result;
}

async function requestOfficeResult(
  client: ExpertCatalogClient,
  method: "integrations/assistant/list" | "integrations/assistant/versions",
  scope: IntegrationScope,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const request: IntegrationRequest = {
    contractVersion: "parallel-v1",
    requestId: `mobile-expert-${Date.now()}-${++nextRequestId}`,
    scope,
    timeoutMs: 30_000,
    payload,
  };
  if (!isContract("IntegrationRequest", request)) throw new Error("AGENT_EXPERTS_REQUEST_INVALID");
  const reply = await requestRead<unknown>(client, method, request, signal, 30_000);
  if (!isIntegrationReply(reply) || reply.requestId !== request.requestId || reply.operationId !== null)
    throw new Error("AGENT_EXPERTS_REPLY_INVALID");
  if (reply.status !== "completed")
    throw new Error(reply.error?.code ?? "AGENT_EXPERTS_READ_FAILED");
  const result = object(reply.result);
  if (!result) throw new Error("AGENT_EXPERTS_REPLY_INVALID");
  return result;
}

async function prepareCatalogRead(client: ExpertCatalogClient, signal?: AbortSignal): Promise<IntegrationScope> {
  throwIfAborted(signal);
  requireOfficeSettingsSupport(client);
  const settings = await requestRead<unknown>(
    client, "settings/integrations/office/read", {}, signal, 15_000,
  );
  throwIfAborted(signal);
  if (!isContract("OfficeSettingsReadResult", settings))
    throw new Error("AGENT_EXPERTS_SETTINGS_INVALID");
  const office = settings as OfficeSettingsReadResult;
  if (!/^[a-f0-9]{64}$/i.test(office.revision) ||
      office.restartRequired !== (office.effectiveEnabled !== office.connectionEnabled))
    throw new Error("AGENT_EXPERTS_SETTINGS_INVALID");
  if (!office.effectiveEnabled || !office.connectionEnabled || office.restartRequired)
    throw new Error("AGENT_EXPERTS_OFFICE_DISABLED");

  requireCatalogSupport(client);
  const scope = await requestRead<unknown>(client, "integrations/scope/read", {}, signal, 15_000);
  if (!isIntegrationScope(scope)) throw new Error("AGENT_EXPERTS_SCOPE_INVALID");
  return scope;
}

function cursorFromPage(value: Record<string, unknown>, itemCount: number, cursor?: string): string | null {
  if (!Number.isSafeInteger(value.total) || (value.total as number) < itemCount ||
      !(value.nextCursor === null || typeof value.nextCursor === "string") || itemCount > PAGE_SIZE)
    throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  if (value.nextCursor !== null && (!value.nextCursor.length || value.nextCursor === cursor))
    throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  return value.nextCursor;
}

function presentation(definition: OfficeAssistantDefinition): { enabled: boolean; team: boolean } {
  const schema = object(definition.inputSchema);
  const metadata = object(schema?.["x-kcoder-expert"]);
  return { enabled: metadata?.enabled !== false, team: metadata?.kind === "team" };
}

function directoryItem(value: unknown): ExpertDirectoryItem | null {
  const item = object(value);
  if (!item || typeof item.builtin !== "boolean" || !isContract("OfficeAssistantDefinition", item.definition))
    throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  if (item.builtin) return null;
  const definition = item.definition as OfficeAssistantDefinition;
  if (!validReferencePart(definition.id)) throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  const state = presentation(definition);
  if (!state.enabled || state.team) return null;
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description ? { description: definition.description } : {}),
  };
}

function sameOwner(
  owner: OfficeAssistantVersion["owner"],
  scope: IntegrationScope,
): boolean {
  return owner.accountId === scope.accountId && owner.targetId === scope.targetId &&
    owner.workspaceId === scope.workspaceId && (owner.organizationId ?? null) === (scope.organizationId ?? null);
}

function expertChoice(value: unknown, id: string, scope: IntegrationScope): ExpertChoice | null {
  if (!isOfficeAssistantVersion(value)) throw new Error("AGENT_EXPERTS_VERSION_INVALID");
  const saved = value as OfficeAssistantVersion;
  if (saved.archived || saved.definition.id !== id || !sameOwner(saved.owner, scope)) return null;
  if (!validReference({ id, version: saved.version, definitionSha256: saved.definitionSha256 }))
    throw new Error("AGENT_EXPERTS_VERSION_INVALID");
  const title = saved.definition.title.trim();
  if (!title) throw new Error("AGENT_EXPERTS_VERSION_INVALID");
  return {
    reference: { id, version: saved.version, definitionSha256: saved.definitionSha256 },
    title: `${title} · ${saved.version}`,
    ...(saved.definition.description ? { description: saved.definition.description } : {}),
  };
}

function ownedClient(
  runtime: TaskRuntime,
  owner: RuntimeOwner,
  signal?: AbortSignal,
): ExpertCatalogClient {
  return {
    supportsExperimental(capability) {
      assertCurrent(runtime, owner, signal);
      return owner.client.supportsExperimental(capability);
    },
    async request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
      assertCurrent(runtime, owner, signal);
      const response = await owner.client.request<T>(method, params ?? {}, timeoutMs);
      assertCurrent(runtime, owner, signal);
      return response;
    },
  };
}

function validateExpertResult(value: unknown, threadId: string): ThreadExpertResult {
  if (!isThreadExpertResult(value) || value.threadId !== threadId)
    throw new Error("AGENT_ORIGINAL_RESPONSE_REQUIRED");
  return value as ThreadExpertResult;
}

export function supportsExperts(this: TaskRuntime): boolean {
  if (this.disposed || !this.snapshot.connected || !this.client || !this.reconnectContext) return false;
  try {
    if (!this.client.matchesRuntimeOwner(this.reconnectContext.profile, this.reconnectContext.server, this.snapshot.cwd))
      return false;
    return taskSupportsExperts(this.client);
  } catch {
    return false;
  }
}

export async function readExpert(this: TaskRuntime, signal?: AbortSignal): Promise<ThreadExpertResult> {
  const owner = currentOwner(this, signal);
  requireThreadExpertSupport(owner.client);
  const result = await owner.client.request<unknown>("thread/expert", { threadId: owner.threadId });
  assertCurrent(this, owner, signal);
  return validateExpertResult(result, owner.threadId);
}

export async function selectExpert(
  this: TaskRuntime,
  reference: AgentDefinitionRef | null,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ThreadExpertResult> {
  const owner = currentOwner(this, signal);
  requireThreadExpertSupport(owner.client);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(expectedRevision + 1) ||
      (reference !== null && !validReference(reference)))
    throw new Error("AGENT_CONFIGURATION_INVALID");
  const params = { threadId: owner.threadId, change: { expectedRevision, expert: reference } };
  if (!isContract("ThreadExpertParams", params)) throw new Error("AGENT_CONFIGURATION_INVALID");
  const response = await owner.client.request<unknown>("thread/expert", params);
  assertCurrent(this, owner, signal);
  const result = validateExpertResult(response, owner.threadId);
  if (result.revision !== expectedRevision + 1)
    throw new Error("AGENT_CONFIGURATION_STALE_REPLY");
  const actual = result.expert?.definition ?? null;
  const matches = reference === null ? actual === null : actual !== null &&
    actual.id === reference.id && actual.version === reference.version &&
    actual.definitionSha256 === reference.definitionSha256;
  if (!matches)
    throw new Error("AGENT_CONFIGURATION_STALE_REPLY");
  return result;
}

export async function listExpertsPage(
  client: ExpertCatalogClient,
  language: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ExpertDirectoryPage> {
  const scope = await prepareCatalogRead(client, signal);
  const result = await requestOfficeResult(client, "integrations/assistant/list", scope, {
    limit: PAGE_SIZE,
    language,
    personalOnly: true,
    ...(cursor ? { cursor } : {}),
  }, signal);
  if (!Array.isArray(result.items)) throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  const items = result.items.map(directoryItem).filter((item): item is ExpertDirectoryItem => item !== null);
  if (new Set(items.map(item => item.id)).size !== items.length)
    throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  const nextCursor = cursorFromPage(result, result.items.length, cursor);
  return { items, nextCursor };
}

export async function listExpertVersions(
  client: ExpertCatalogClient,
  id: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ExpertVersionPage> {
  if (!validReferencePart(id)) throw new Error("AGENT_EXPERTS_ID_REQUIRED");
  const scope = await prepareCatalogRead(client, signal);
  const result = await requestOfficeResult(client, "integrations/assistant/versions", scope, {
    id,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  }, signal);
  if (!Array.isArray(result.items)) throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  const items = result.items.map(item => expertChoice(item, id, scope)).filter((item): item is ExpertChoice => item !== null);
  const identities = items.map(item => JSON.stringify(item.reference));
  if (new Set(identities).size !== identities.length)
    throw new Error("AGENT_EXPERTS_PAGE_INVALID");
  const nextCursor = cursorFromPage(result, result.items.length, cursor);
  return { items, nextCursor };
}

export function listExperts(
  this: TaskRuntime,
  language: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ExpertDirectoryPage> {
  const owner = currentOwner(this, signal);
  const client = ownedClient(this, owner, signal);
  return listExpertsPage(client, language, cursor, signal).then(result => {
    assertCurrent(this, owner, signal);
    return result;
  });
}

export function listExpertVersionsForTask(
  this: TaskRuntime,
  id: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ExpertVersionPage> {
  const owner = currentOwner(this, signal);
  const client = ownedClient(this, owner, signal);
  return listExpertVersions(client, id, cursor, signal).then(result => {
    assertCurrent(this, owner, signal);
    return result;
  });
}

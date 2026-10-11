import { prepareCatalogRead, type NewCatalogReadSource } from "./new-catalog-read-source";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import type { GatewayRpcClient } from "@/gateway/rpc";
import {
  readModelConfiguration,
  type ModelConfigurationSummary,
} from "../../../../shared/modelConfiguration";
import { ScopedReadCache } from "../scoped-read-cache";
import { taskClientConnector } from "./connectionFactory";

export interface ModelOption {
  configuration?: ModelConfigurationSummary;
  id: string;
  model: string;
  displayName: string;
  providerId: string;
  providerName: string;
  providerCurrent?: boolean;
  isDefault?: boolean;
  supportsVision?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  supportsFastMode?: boolean;
}

export function defaultModelOption(
  models: readonly ModelOption[],
): ModelOption | undefined {
  return (
    models.find((model) => model.providerCurrent && model.isDefault) ??
    models.find((model) => model.isDefault)
  );
}

export function modelOptionSelector(model: ModelOption): string {
  return model.id.includes("::")
    ? model.id
    : `${model.providerId}::${model.model}`;
}

export function threadModelSelector(
  thread?: Pick<
    ThreadSummary,
    "model" | "modelProvider" | "model_provider" | "providerId"
  >,
): string | undefined {
  const model = thread?.model;
  const provider =
    thread?.modelProvider ?? thread?.model_provider ?? thread?.providerId;
  return model && provider && !model.includes("::")
    ? `${provider}::${model}`
    : model;
}

export function selectedModelOption(
  models: readonly ModelOption[],
  selection?: string,
): ModelOption | undefined {
  return (
    models.find((model) => modelOptionSelector(model) === selection) ??
    models.find((model) => model.model === selection) ??
    (models.filter((model) => model.providerId === selection).length === 1
      ? models.find((model) => model.providerId === selection)
      : undefined)
  );
}

const modelCache = new ScopedReadCache<ModelOption[]>(32, 30_000);
export function clearModelCache(profileId?: string): void {
  modelCache.clear(profileId ? (key) => JSON.parse(key)[0] === profileId : undefined);
}
export async function listModels(profile: GatewayProfile, server: KCoderServer, options: { signal?: AbortSignal; source?: NewCatalogReadSource } = {}): Promise<ModelOption[]> {
  const key = await prepareCatalogRead(profile, server, options.signal);
  options.source?.assertOwner(profile, server);
  const read = () => modelCache.get(key, signal => options.source
    ? options.source.withClient("models", signal, readModelsOnClient)
    : loadModels(profile, server, signal), options.signal);
  return options.source ? options.source.cacheRead("models", read) : read();
}

async function loadModels(
  profile: GatewayProfile,
  server: KCoderServer,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
    "runtime",
    { signal },
  );
  const cancel = () => client.close();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("模型目录读取已取消");
    return await readModelsOnClient(client);
  } finally {
    signal.removeEventListener("abort", cancel);
    client.close();
  }
}

async function readModelsOnClient(client: Pick<GatewayRpcClient, "request">): Promise<ModelOption[]> {
  const result = await client.request<{ data?: ModelOption[] }>(
    "runtime.models.list",
  );
  return Array.isArray(result.data)
    ? result.data.map((model) => {
        const configuration = readModelConfiguration(model.configuration);
        const reasoningPolicy = configuration?.reasoningPolicy;
        return {
          ...model,
          configuration,
          ...(reasoningPolicy
            ? {
                supportedReasoningEfforts:
                  reasoningPolicy.mode === "optional"
                    ? reasoningPolicy.efforts
                    : [],
              }
            : {}),
        };
      })
    : [];
}

export async function restoreReasoningEffortForThread(
  client: Pick<GatewayRpcClient, "request">,
  threadId: string,
  model: string | undefined,
  effort: string | undefined,
): Promise<string | undefined> {
  if (!effort || !model) return effort;
  try {
    const result = await client.request<{ activeConfiguration?: unknown }>(
      "runtime.models.list",
      { threadId },
    );
    const configuration = readModelConfiguration(result.activeConfiguration);
    if (!configuration || !configurationMatchesModel(configuration, model))
      return effort;
    const policy = configuration.reasoningPolicy;
    if (!policy) return effort;
    if (policy.mode === "hidden" || policy.mode === "always_off")
      return undefined;
    if (policy.efforts.includes(effort)) return effort;
    const defaultEffort = configuration.reasoningEffort?.trim();
    return defaultEffort && policy.efforts.includes(defaultEffort)
      ? defaultEffort
      : undefined;
  } catch {
    // Older targets may not expose an active configuration projection.
    return effort;
  }
}

function configurationMatchesModel(
  configuration: ModelConfigurationSummary,
  model: string,
): boolean {
  const separator = model.indexOf("::");
  if (separator < 0) return configuration.modelId === model;
  return (
    configuration.providerId === model.slice(0, separator) &&
    configuration.modelId === model.slice(separator + 2)
  );
}

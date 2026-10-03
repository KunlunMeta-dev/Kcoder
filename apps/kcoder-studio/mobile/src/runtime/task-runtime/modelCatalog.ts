import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import {
  readModelConfiguration,
  type ModelConfigurationSummary,
} from "../../../../shared/modelConfiguration";
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
    models.find((model) => model.isDefault) ??
    models.find((model) => model.providerCurrent) ??
    models[0]
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

export async function listModels(
  profile: GatewayProfile,
  server: KCoderServer,
): Promise<ModelOption[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ data?: ModelOption[] }>(
      "runtime.models.list",
    );
    return Array.isArray(result.data)
      ? result.data.map((model) => ({
          ...model,
          configuration: readModelConfiguration(model.configuration),
        }))
      : [];
  } finally {
    client.close();
  }
}

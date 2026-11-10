export type TargetSettingsRequest = <T>(method: string, params?: unknown) => Promise<T>;

export interface TargetPluginSummary {
  id: string;
  name: string;
  version?: string | null;
  description?: string | null;
  enabled: boolean;
  diagnosticCount?: number;
}

export interface TargetPluginDiagnostic {
  code: string;
  message: string;
}

export interface TargetSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  userInvocable: boolean;
}

export async function readTargetPluginList(
  request: TargetSettingsRequest,
): Promise<{ plugins: TargetPluginSummary[]; diagnostics: TargetPluginDiagnostic[] }> {
  const result = await request<{
    plugins?: TargetPluginSummary[];
    diagnostics?: TargetPluginDiagnostic[];
  }>("plugin/list", { all: true });
  if (!Array.isArray(result?.plugins) || !Array.isArray(result?.diagnostics)) {
    throw new Error("The target returned an invalid plugin list");
  }
  return {
    plugins: result.plugins,
    diagnostics: result.diagnostics,
  };
}

export async function readTargetSkillList(
  request: TargetSettingsRequest,
): Promise<{ items: TargetSkillSummary[]; appliesToNewConversations: boolean }> {
  const result = await request<{
    items?: TargetSkillSummary[];
    appliesToNewConversations?: boolean;
  }>("skills/list", { includeDisabled: true });
  if (!Array.isArray(result?.items) || typeof result.appliesToNewConversations !== "boolean") {
    throw new Error("The target returned an invalid skill list");
  }
  return {
    items: result.items,
    appliesToNewConversations: result.appliesToNewConversations,
  };
}

export async function setTargetPluginEnabled(
  request: TargetSettingsRequest,
  pluginId: string,
  enabled: boolean,
): Promise<TargetPluginSummary | null> {
  if (!pluginId.trim()) throw new Error("A plugin ID is required");
  const result = await request<{
    plugin?: TargetPluginSummary | null;
    changed?: boolean;
  }>(enabled ? "plugin/enable" : "plugin/disable", { pluginId });
  if (!result?.plugin) throw new Error("The target did not confirm the plugin state");
  if (result?.plugin && (result.plugin.id !== pluginId || result.plugin.enabled !== enabled)) {
    throw new Error("The target returned a mismatched plugin update receipt");
  }
  return result.plugin;
}

export async function setTargetSkillEnabled(
  request: TargetSettingsRequest,
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!name.trim()) throw new Error("A skill name is required");
  const receipt = await request<{
    name?: string;
    enabled?: boolean;
    appliesToNewConversations?: boolean;
  }>("skills/setEnabled", { name, enabled });
  if (
    receipt?.name !== name ||
    receipt.enabled !== enabled ||
    receipt.appliesToNewConversations !== true
  ) {
    throw new Error("The target returned an invalid skill activation receipt");
  }
}

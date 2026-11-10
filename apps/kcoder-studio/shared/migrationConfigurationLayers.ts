import type {
  MigrationConfigurationLayersParams,
  MigrationConfigurationLayersResult,
} from "./generated/contracts";

export const CONFIGURATION_LAYERS_CAPABILITY = "migrationConfigurationLayersV1";
const supported = new Set([
  "/model",
  "/$schema",
  "/env",
  "/env/ANTHROPIC_MODEL",
  "/env/ANTHROPIC_BASE_URL",
  "/env/ANTHROPIC_API_KEY",
]);
const unsupported = new Set([
  "/env/ANTHROPIC_AUTH_TOKEN",
  "/env/CLAUDE_CODE_OAUTH_TOKEN",
  "/apiKeyHelper",
  "/hooks",
  "/permissions",
  "/mcpServers",
]);
const unobserved = [
  "managed_settings",
  "command_line_settings",
  "source_process_environment",
  "git_worktree_local_routing",
  "separate_mcp_namespaces",
];
/** Validate correlation and bounds after the generated schema check; never display arbitrary stored names. */
export function validConfigurationLayers(
  params: MigrationConfigurationLayersParams,
  result: MigrationConfigurationLayersResult,
): boolean {
  const a = params.target,
    b = result.target;
  if (
    a.kind !== b.kind ||
    (a.kind === "source"
      ? b.kind !== "source" || a.sourceId !== b.sourceId
      : b.kind !== "job" ||
        a.jobId !== b.jobId ||
        (a.itemId ?? null) !== (b.itemId ?? null))
  )
    return false;
  const page = params.pageIndex ?? 0;
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    page > 102 ||
    result.pageIndex !== page ||
    result.fields.length > 10 ||
    !Number.isInteger(result.totalFields) ||
    result.totalFields < 0 ||
    result.totalFields > 1024
  )
    return false;
  if (result.status !== "available")
    return (
      page === 0 &&
      result.fields.length === 0 &&
      result.layers.length === 0 &&
      result.totalFields === 0 &&
      result.nextPage == null &&
      result.adapterRevision == null &&
      result.unobserved.length === 0
    );
  if (
    result.adapterRevision !== "claude-settings-layers/v1" ||
    ![1, 3].includes(result.layers.length) ||
    result.layers.some(
      (layer, i) => layer.scope !== ["user", "project", "local"][i],
    ) ||
    JSON.stringify(result.unobserved) !== JSON.stringify(unobserved)
  )
    return false;
  if (
    result.fields.length !==
      Math.max(0, Math.min(10, result.totalFields - page * 10)) ||
    (page > 0 && page * 10 >= result.totalFields) ||
    result.nextPage !== (page * 10 + 10 < result.totalFields ? page + 1 : null)
  )
    return false;
  return result.fields.every(
    (field, i) =>
      field.ordinal === page * 10 + i &&
      field.scopes.length > 0 &&
      field.scopes.length <= 3 &&
      new Set(field.scopes).size === field.scopes.length &&
      field.scopes.every((scope) =>
        result.layers.some((layer) => layer.scope === scope && layer.present),
      ) &&
      (field.field == null
        ? !field.supported
        : supported.has(field.field)
          ? field.supported
          : unsupported.has(field.field) && !field.supported),
  );
}

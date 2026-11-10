import type {
  MigrationCodexLayersReadResult,
  MigrationConfigurationLayersParams,
  MigrationCodexLayersSelectParams,
  MigrationCodexLayersSelectResult,
} from "./generated/contracts";
export const CODEX_LAYERS_CAPABILITY = "migrationCodexLayersV1";
const fields = new Set([
  "/model",
  "/model_context_window",
  "/model_reasoning_effort",
  "/model_provider",
  "/model_providers",
  "/project_root_markers",
  "/profile",
  "/profiles",
  "/projects",
  "/openai_base_url",
  "/chatgpt_base_url",
  "/apps_mcp_product_sku",
  "/notify",
  "/otel",
  "/experimental_realtime_ws_base_url",
  "/mcp_servers",
  "/hooks",
  "/permissions",
  "/sandbox_mode",
  "/approval_policy",
  "/model_instructions_file",
  ...[
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "requires_openai_auth",
    "auth",
    "experimental_bearer_token",
    "http_headers",
    "env_http_headers",
  ].map((name) => `/model_providers/${name}`),
]);
const unobserved = [
  "command_line_overrides",
  "source_process_environment",
  "system_cloud_managed_defaults",
  "managed_requirements",
  "separate_mcp_namespaces",
  "git_worktree_runtime_routing",
];
export function validCodexLayerSelection(
  params: MigrationCodexLayersSelectParams,
  value: MigrationCodexLayersSelectResult,
): boolean {
  return (
    params.includeProject === true &&
    value.source.kind === "codex" &&
    value.source.scope === "codex-project-layers" &&
    value.source.formatRevision === "codex-selected-layers/v1" &&
    !!value.source.sourceId &&
    value.source.sourceId !== params.sourceId &&
    value.replacesSourceIds.length <= 256 &&
    value.replacesSourceIds.includes(params.sourceId) &&
    !value.replacesSourceIds.includes(value.source.sourceId) &&
    new Set(value.replacesSourceIds).size === value.replacesSourceIds.length
  );
}
export function validCodexLayerReport(
  params: MigrationConfigurationLayersParams,
  value: MigrationCodexLayersReadResult,
): boolean {
  const a = params.target,
    b = value.target;
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
    value.pageIndex !== page ||
    value.fields.length > 10 ||
    value.totalFields > 1024
  )
    return false;
  if (value.status !== "available")
    return (
      page === 0 &&
      value.fields.length === 0 &&
      value.layers.length === 0 &&
      value.totalFields === 0 &&
      value.nextPage == null &&
      value.adapterRevision == null &&
      value.unobserved.length === 0
    );
  if (
    value.adapterRevision !== "codex-selected-layers/v1" ||
    value.layers.length < 2 ||
    value.layers.length > 66 ||
    value.layers.some(
      (layer, index) =>
        layer.index !== index ||
        (index === 0
          ? layer.kind !== "user"
          : index === 1
            ? !["profile", "project"].includes(layer.kind)
            : layer.kind !== "project"),
    ) ||
    JSON.stringify(value.unobserved) !== JSON.stringify(unobserved)
  )
    return false;
  if (
    value.fields.length !==
      Math.max(0, Math.min(10, value.totalFields - page * 10)) ||
    (page > 0 && page * 10 >= value.totalFields) ||
    value.nextPage !== (page * 10 + 10 < value.totalFields ? page + 1 : null)
  )
    return false;
  return value.fields.every(
    (field) =>
      (field.field == null || fields.has(field.field)) &&
      value.layers[field.layer]?.present === true &&
      (field.providerIndex == null ||
        (Number.isInteger(field.providerIndex) &&
          field.providerIndex >= 0 &&
          field.providerIndex < 1024)),
  );
}

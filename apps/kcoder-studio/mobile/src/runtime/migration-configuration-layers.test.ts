import { expect, it, vi } from "vitest";
import { MobileMigrationClient } from "./migration-client";
import { validConfigurationLayers } from "../../../shared/migrationConfigurationLayers";
const params = { target: { kind: "source" as const, sourceId: "owned" }, pageIndex: 0 };
const result = { target: params.target, status: "available" as const, pageIndex: 0, adapterRevision: "claude-settings-layers/v1", layers: [{ scope: "user" as const, present: true }], fields: [{ field: "/env/ANTHROPIC_API_KEY", ordinal: 0, scopes: ["user" as const], supported: true, private: true }], totalFields: 1, nextPage: null, unobserved: ["managed_settings", "command_line_settings", "source_process_environment", "git_worktree_local_routing", "separate_mcp_namespaces"] };
it("requires the independent capability, creates no intent and fences late target/account reports", async () => {
  const request = vi.fn(async () => result), put = vi.fn(), journal = { read: async () => [], put };
  const old = new MobileMigrationClient(request, { migrationProvidersV1: true }, journal, () => true);
  await expect(old.call("configurationLayers", params)).rejects.toMatchObject({ code: "migration_update_required" });
  expect(request).not.toHaveBeenCalled();
  let current = true;
  const client = new MobileMigrationClient(request, { migrationConfigurationLayersV1: true }, journal, () => current);
  await expect(client.call("configurationLayers", params)).resolves.toEqual(result);
  expect(put).not.toHaveBeenCalled();
  let resolve!: (value: typeof result) => void;
  request.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  const late = client.call("configurationLayers", params); current = false; resolve(result);
  await expect(late).rejects.toMatchObject({ code: "migration_scope_changed" });
});
it("rejects arbitrary names, unknown authorities, malformed page bounds and mismatched selections", async () => {
  for (const response of [{ ...result, target: { kind: "source", sourceId: "other" } }, { ...result, fields: [{ ...result.fields[0], field: "PRIVATE_NAME" }] }, { ...result, nextPage: 0 }, { ...result, totalFields: 1025 }, { ...result, fields: Array(11).fill(result.fields[0]) }, { ...result, layers: [{ scope: "process", present: true }] }, { ...result, unobserved: ["PRIVATE_PROCESS_ARGUMENT"] }]) {
    const client = new MobileMigrationClient(async () => response, { migrationConfigurationLayersV1: true }, { read: async () => [], put: async () => {} }, () => true);
    await expect(client.call("configurationLayers", params)).rejects.toMatchObject({ code: "migration_invalid_response" });
  }
  expect(validConfigurationLayers(params, result)).toBe(true);
});

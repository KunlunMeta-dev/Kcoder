import React from "react";
vi.mock("@/components/settings/SettingsTargetContext", () => ({ useSettingsTarget() { throw new Error("Project target selection is outside this non-project fixture"); } }));
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
vi.mock("@/i18n", async () => { const { en } = await import("@/i18n/locales/en"); return { t: (key: string, fields: Record<string, unknown> = {}) => Object.entries(fields).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key] ?? key) }; });
vi.mock("@/components/settings/settings-layout", async () => { const React = await import("react"); return { SettingsGroup: ({ children }: React.PropsWithChildren) => React.createElement("section", null, children), SettingsRow: ({ label, note }: Record<string, string>) => React.createElement("article", null, label, note) }; });
import { MigrationSources } from "./MigrationSources";
import { MigrationItemEditor } from "./MigrationItemEditor";
import { MigrationPluginRecord } from "./MigrationPluginRecord";
import { Confirm } from "./WorkbenchUi";
import { MobileMigrationClient, type MigrationItemsResult } from "@/runtime/migration-client";
import { migrationWorkbenchEn } from "@/i18n/locales/migration-workbench.en";
import { migrationWorkbenchZhCN } from "@/i18n/locales/migration-workbench.zh-CN";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: React.ReactNode): string };
const request = vi.fn(async () => { throw new Error("SSR cannot dispatch"); });
const client = new MobileMigrationClient(request, { migrationBatchV1: true, migrationProvidersV1: true }, { read: async () => [], put: async () => {} }, () => true);
it("does not auto-select a vendor or discover any source merely by opening the Mobile page", () => {
  const html = renderToStaticMarkup(<MigrationSources client={client} onJob={() => {}}/>);
  expect(html).toContain("Claude Code"); expect(html).toContain("Codex");
  expect(html).not.toContain("migration-scan-selection");
  expect(request).not.toHaveBeenCalled();
});
it("retains unsupported items with a useful outcome instead of silently selecting or hiding them", () => {
  const page: MigrationItemsResult = { items: [{ id: "unsupported", sourceName: "unsupported-hook", category: "hook", selectedByDefault: false, status: "requires_action", issues: [] }], drafts: [{ itemId: "unsupported", targetName: "unsupported-hook", choice: null }] };
  const html = renderToStaticMarkup(<MigrationItemEditor client={client} jobId="owned-job" page={page} itemId="unsupported" choices={[]} onSave={() => {}} onClose={() => {}}/>);
  expect(html).toContain("unsupported-hook");
  expect(html).toContain(migrationWorkbenchEn["migration_workbench.unsupported_item"]);
  expect(html).not.toContain("migration-item-save");
});
it("separates a static plugin copy from activation and uses explicit confirmation, not an automatic apply", () => {
  const html = renderToStaticMarkup(<MigrationPluginRecord client={client} operationId="original-operation" onUse={() => {}} onBatch={() => {}}/>);
  expect(html).toContain("original-operation");
  expect(html).toContain("Ready means a static copy only");
  expect(html).toContain("first IMPORT");
  expect(request).not.toHaveBeenCalled();
  const confirm = renderToStaticMarkup(<Confirm keyword="IMPORT" value="no" onChange={() => {}} onConfirm={() => {}} onDismiss={() => {}} busy={false} testID="confirm"/>);
  expect(confirm).toContain("Type IMPORT");
  expect(confirm).toContain('aria-disabled="true"');
});
it("keeps a provider with missing model limits configurable even when Native cannot propose a complete default", () => {
  const page: MigrationItemsResult = { items: [{ id: "provider", sourceName: "anthropic", category: "provider", selectedByDefault: false, status: "requires_action", issues: [{ code: "missing_model_limits", severity: "blocking", phase: "import", field: null }] }], providers: [{ itemId: "provider", apiFormat: "anthropic_messages", endpoint: "https://example.invalid/v1", model: "explicit-model", contextWindowTokens: null, outputHeadroomTokens: null, maxOutputTokens: null }], drafts: [{ itemId: "provider", targetName: "imported-office", choice: null }] };
  const html = renderToStaticMarkup(<MigrationItemEditor client={client} jobId="owned-job" page={page} itemId="provider" choices={[]} onSave={() => {}} onClose={() => {}}/>);
  expect(html).toContain("migration-provider-context");
  expect(html).toContain("migration-provider-headroom");
  expect(html).toContain("migration-provider-output");
  expect(html).not.toContain(migrationWorkbenchEn["migration_workbench.unsupported_item"]);
  expect(html).toContain('aria-disabled="true"');
});
it("renders only ten private field choices instead of expanding the entire MCP environment/header catalog", () => {
  const candidate = { itemId: "mcp", name: "documents", transport: "stdio", command: "sh", url: "", cwd: null, sourceCwd: null, requiredEnv: Array.from({ length: 14 }, (_, index) => `FIELD_${index}`), requiredHeaders: ["HEADER_A", "HEADER_B"], enabledInSource: false };
  const page: MigrationItemsResult = { items: [{ id: "mcp", sourceName: "documents", category: "mcp", selectedByDefault: false, status: "requires_action", issues: [] }], mcps: [candidate], drafts: [{ itemId: "mcp", targetName: "imported-mcp", choice: null }] };
  const supported = new MobileMigrationClient(request, { migrationMcpV1: true, migrationBatchMcpCredentialsV1: true }, { read: async () => [], put: async () => {} }, () => true);
  const html = renderToStaticMarkup(<MigrationItemEditor client={supported} jobId="owned-job" page={page} itemId="mcp" choices={[]} onSave={() => {}} onClose={() => {}}/>);
  expect(html.match(/data-testid="migration-private-/g)).toHaveLength(10);
  expect(html).not.toContain("FIELD_10"); expect(html).not.toContain("HEADER_B");
});
it("keeps matching complete English and Chinese resources without embedding secret values in fields", () => {
  expect(Object.keys(migrationWorkbenchEn).sort()).toEqual(Object.keys(migrationWorkbenchZhCN).sort());
  for (const [key, text] of Object.entries(migrationWorkbenchEn)) {
    expect(text).not.toBe(""); expect(migrationWorkbenchZhCN[key]).not.toBe("");
    const fields = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    expect(fields(text)).toEqual(fields(migrationWorkbenchZhCN[key]));
  }
});

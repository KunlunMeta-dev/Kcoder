import React from "react";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
vi.mock("@/i18n", async () => { const { en } = await import("@/i18n/locales/en"); return { t: (key: string) => en[key] ?? key }; });
import { MobileMigrationClient } from "@/runtime/migration-client";
import { migrationCodexEn } from "@/i18n/locales/migration-codex.en";
import { migrationCodexZhCN } from "@/i18n/locales/migration-codex.zh-CN";
import { MigrationCodexLayerReport } from "./MigrationCodexLayerReport";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: React.ReactNode): string };
it("keeps the independent Codex report passive and absent on B1-only targets", () => {
  const request = vi.fn(async () => { throw new Error("SSR must remain passive"); });
  const journal = { read: async () => [], put: async () => {} }, target = { kind: "source" as const, sourceId: "owned" };
  const current = new MobileMigrationClient(request, { migrationCodexLayersV1: true }, journal, () => true);
  const html = renderToStaticMarkup(<MigrationCodexLayerReport client={current} target={target}/>);
  expect(html).toContain("Codex project layer details");
  expect(html).not.toContain("migration-codex-report-details");
  expect(request).not.toHaveBeenCalled();
  const old = new MobileMigrationClient(request, { migrationConfigurationLayersV1: true }, journal, () => true);
  expect(renderToStaticMarkup(<MigrationCodexLayerReport client={old} target={target}/>)).toBe("");
});
it("pairs locale parameters and names the actual static trust and routing boundaries", () => {
  expect(Object.keys(migrationCodexEn).sort()).toEqual(Object.keys(migrationCodexZhCN).sort());
  for (const [key, text] of Object.entries(migrationCodexEn)) {
    const fields = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    expect(fields(text)).toEqual(fields(migrationCodexZhCN[key as keyof typeof migrationCodexZhCN]));
  }
  expect(migrationCodexEn["migration_codex.boundary"]).toContain("not establish the source process’s final configuration");
  expect(migrationCodexEn["migration_codex.boundary"]).toContain("Git/worktree");
  expect(migrationCodexEn["migration_codex.replacement"]).toContain("MCP separately");
});

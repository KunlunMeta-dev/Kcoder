import React from "react";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
vi.mock("@/i18n", async () => { const { en } = await import("@/i18n/locales/en"); return { t: (key: string) => en[key] ?? key }; });
import { MobileMigrationClient } from "@/runtime/migration-client";
import { migrationLayersEn } from "@/i18n/locales/migration-layers.en";
import { migrationLayersZhCN } from "@/i18n/locales/migration-layers.zh-CN";
import { MigrationConfigurationLayers } from "./MigrationConfigurationLayers";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: React.ReactNode): string };
it("keeps field origins in a passive disclosure and hides the feature on old targets", () => {
  const request = vi.fn(async () => { throw new Error("SSR must remain passive"); });
  const journal = { read: async () => [], put: async () => {} };
  const current = new MobileMigrationClient(request, { migrationConfigurationLayersV1: true }, journal, () => true);
  const target = { kind: "source" as const, sourceId: "owned" };
  const html = renderToStaticMarkup(<MigrationConfigurationLayers client={current} target={target}/>);
  expect(html).toContain("Settings layer details");
  expect(html).not.toContain("migration-layer-details");
  expect(request).not.toHaveBeenCalled();
  const old = new MobileMigrationClient(request, { migrationProvidersV1: true }, journal, () => true);
  expect(renderToStaticMarkup(<MigrationConfigurationLayers client={old} target={target}/>)).toBe("");
});
it("pairs locale fields and explicitly distinguishes the selected file snapshot from runtime authority", () => {
  expect(Object.keys(migrationLayersEn).sort()).toEqual(Object.keys(migrationLayersZhCN).sort());
  for (const [key, text] of Object.entries(migrationLayersEn)) {
    const fields = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    expect(fields(text)).toEqual(fields(migrationLayersZhCN[key as keyof typeof migrationLayersZhCN]));
  }
  expect(migrationLayersEn["migration_layers.boundary"]).toContain("not the source application’s final runtime configuration");
  expect(migrationLayersEn["migration_layers.private"]).toContain("hidden");
});

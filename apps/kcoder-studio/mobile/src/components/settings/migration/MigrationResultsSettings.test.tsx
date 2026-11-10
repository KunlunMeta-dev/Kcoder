import React from "react";
vi.mock("expo-router", () => ({ useRouter: () => ({ push() {} }), useIsFocused: () => true }));
import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { migrationResultsEn } from "@/i18n/locales/migration-results.en";
import { migrationResultsZhCN } from "@/i18n/locales/migration-results.zh-CN";
const state = vi.hoisted(() => ({ pages: {} as Record<string, unknown> }));
vi.mock("./useMigrationRead", () => ({ useMigrationRead: (_reader: unknown, name: string, _params: unknown, enabled: boolean) => ({ value: enabled ? state.pages[name] ?? null : null, error: null, loading: false }) }));
vi.mock("@/i18n", async () => { const { en } = await import("@/i18n/locales/en"); return { t: (key: string, params: Record<string, unknown> = {}) => Object.entries(params).reduce((value, [name, item]) => value.replaceAll(`{${name}}`, String(item)), en[key] ?? key) }; });
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/components/settings/SettingsTargetContext", () => ({ useSettingsTarget: () => ({ ready: false, targetIdentity: null, capabilities: { appServer: null } }) }));
vi.mock("@/components/settings/settings-layout", async () => {
    const React = await import("react");
    return { SettingsGroup: ({ children }: React.PropsWithChildren) => React.createElement("section", null, children), SettingsRow: ({ label, note, value }: Record<string, string>) => React.createElement("article", null, label, note, value) };
});
import { ConfigurationJob, HistoryJob, JobList, MigrationResultsSettings } from "../MigrationResultsSettings";
import { RecordBlocks } from "./MigrationHistoryRecords";
import { appendPage } from "./migration-result-ui";
import { MigrationResultsReader } from "@/runtime/migration-results";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
    renderToStaticMarkup(element: React.ReactNode): string;
};
const reader = new MigrationResultsReader(async () => { throw new Error("SSR must not request"); }, { migrationHistoryReadV1: true });
beforeEach(() => { state.pages = {}; });
it("shows the target-only read scope and an explicit selection prompt before connection", () => {
    const html = renderToStaticMarkup(<MigrationResultsSettings />);
    expect(html).toContain(en["migration_results.readonly_note"]);
    expect(html).toContain(en["migration_results.select_target"]);
});
it("renders the server page without merging an eleventh row or dispatching work", () => {
    state.pages.jobs = { jobs: Array.from({ length: 10 }, (_, index) => ({ job: { jobId: `fixture-job-${index}`, status: "completed" } })), nextCursor: "sealed-next" };
    const html = renderToStaticMarkup(<JobList reader={reader} name="jobs" onSelect={() => { }}/>);
    expect(html.match(/fixture-job-/g)).toHaveLength(10);
    expect(html).toContain("Saved");
    expect(html).not.toContain("Resume migration");
});
it("history lists distinguish unknown ownership without assuming old or missing negotiated reports are stopped", () => {
    state.pages.historyJobs = { jobs: [{ job: { jobId: "owned", stage: "normalizing" }, workerRunning: false, workerState: "unknown" }] };
    expect(renderToStaticMarkup(<JobList reader={reader} name="historyJobs" onSelect={() => {}} workerStateNegotiated/>)).toContain(en["migration_history.worker_unknown_label"]);
    state.pages.historyJobs = { jobs: [{ job: { jobId: "old", stage: "normalizing" }, workerRunning: false }] };
    expect(renderToStaticMarkup(<JobList reader={reader} name="historyJobs" onSelect={() => {}} workerStateNegotiated/>)).toContain(en["migration_history.worker_unknown_label"]);
    const legacy = renderToStaticMarkup(<JobList reader={reader} name="historyJobs" onSelect={() => {}}/>);
    expect(legacy).not.toContain(en["migration_history.worker_stopped"]); expect(legacy).not.toContain(en["migration_history.worker_unknown_label"]);
});
it("distinguishes unknown and cancel-requested facts from completion", () => {
    state.pages.job = { job: { status: "cancel_requested", committedItems: 1, totalItems: 2, hasUnconfirmedOutcomes: true }, issues: [] };
    const html = renderToStaticMarkup(<ConfigurationJob reader={reader} jobId="a"/>);
    expect(html).toContain(en["migration_results.unknown_outcome"]);
    expect(html).toContain(en["migration_results.cancel_requested"]);
    expect(html).toContain(en["migration_results.saved_not_verified"]);
    state.pages.history = { job: { stage: "failed", cancelRequested: true, failureCode: "history_source_changed" }, workerRunning: false, workerError: null };
    const history = renderToStaticMarkup(<HistoryJob reader={reader} jobId="h"/>);
    expect(history).toContain("Failed");
    expect(history).toContain("history_source_changed");
    expect(history).not.toContain("Worker active");
});
it("keeps archived content inert and does not report recorded results as success", () => {
    state.pages.blocks = { blocks: [{ index: 0, kind: "tool_result", preview: "<script>source-only</script>", outcome: "recorded_result", bodyAvailable: true }, { index: 1, kind: "opaque", preview: null, bodyAvailable: false }], nextCursor: null };
    const html = renderToStaticMarkup(<RecordBlocks reader={reader} jobId="h" record={0}/>);
    expect(html).toContain("&lt;script&gt;source-only&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(en["migration_results.outcome_recorded_result"]);
    expect(html).toContain(en["migration_results.opaque_note"]);
});
it("bounds local pagination history and composes complete matching English and Chinese resources", () => {
    let pages: Array<string | null> = [null];
    for (let index = 0; index < 1000; index++)
        pages = appendPage(pages, String(index));
    expect(pages).toHaveLength(256);
    expect(pages.at(-1)).toBe("999");
    expect(Object.keys(migrationResultsEn).sort()).toEqual(Object.keys(migrationResultsZhCN).sort());
    for (const [key, value] of Object.entries(migrationResultsEn)) {
        expect(en[key]).toBe(value);
        expect(zhCN[key]).toBe(migrationResultsZhCN[key]);
    }
});

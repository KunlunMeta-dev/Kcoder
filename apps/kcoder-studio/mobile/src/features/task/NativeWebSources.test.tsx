import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import fixtures from "../../../../shared/generated/examples.web-sources.json";
import { normalizeWebSources, type WebSourcesV1 } from "../../../../shared/webSources";
import { NativeWebSources } from "./NativeWebSources";
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", Linking: { openURL: vi.fn(async () => {}) } }));
vi.mock("lucide-react-native", () => ({ ChevronLeft: () => null, ChevronRight: () => null, ChevronDown: () => null, Globe: () => null }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: { textMuted: "gray" } }) }));
const seed = fixtures.WebSourcesToolResultV1.find(value => value.name === "native-summary")?.value.webSources;
if (!seed) throw new Error("Native summary fixture is required");
const sample = seed;
const attempts: WebSourcesV1["attempts"] = [
  { provider: "exa-public", status: "failed", elapsedMs: 20, error: "network", requestSent: true },
  { provider: "searxng-bundled", status: "failed", elapsedMs: 2, error: "component_unavailable", requestSent: false },
  { provider: "bing-html", status: "success", elapsedMs: 10, requestSent: true },
];

it("keeps trusted terminal switching in the existing disclosure", async () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...sample.sources[0], sourceId: "native-large-" + index }));
  const receipt = normalizeWebSources({ ...sample, sources, status: "success", provider: "bing-html", attempts }, { toolCallId: "search-1" })!;
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(<NativeWebSources receipt={receipt} />); });
  expect(root.root.findByProps({ testID: "native-source-switch" })).toBeTruthy();
  expect(root.root.findAllByProps({ testID: "native-source-attempts" })).toHaveLength(0);
  await act(async () => { root.root.findByProps({ testID: "native-sources-toggle-search-1" }).props.onPress(); });
  expect(root.root.findAllByProps({ testID: "native-source-attempt" })).toHaveLength(3);
  const text = JSON.stringify(root.toJSON());
  for (const provider of ["exa-public", "searxng-bundled", "bing-html"]) expect(text).toContain(provider);
  expect(text).toContain("web_sources.failed");
  expect(text).toContain("web_sources.success");
  await act(async () => { root.unmount(); });
});

it("keeps old one-attempt records compact and preserves empty or cancelled outcomes", async () => {
  for (const value of [
    sample, Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'attempts')),
    ...(["empty", "cancelled"] as const).map(status => ({
      ...sample, status, sources: [], attempts: [...attempts.slice(0, 2), { ...attempts[2], status }],
    })),
  ]) {
    const receipt = normalizeWebSources(value, { toolCallId: "search-1" })!;
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(<NativeWebSources receipt={receipt} />); });
    expect(root.root.findAllByProps({ testID: "native-source-switch" })).toHaveLength(receipt.attempts.length > 1 ? 1 : 0);
    if (!receipt.sources.length) await act(async () => { root.root.findByProps({ testID: "native-sources-toggle-search-1" }).props.onPress(); });
    if (receipt.status === "empty" || receipt.status === "cancelled") {
      expect(JSON.stringify(root.toJSON())).toContain("web_sources." + receipt.status);
      expect(JSON.stringify(root.toJSON())).not.toContain("web_sources.success");
    } else expect(root.root.findAllByProps({ testID: "native-source-attempts" })).toHaveLength(0);
    await act(async () => { root.unmount(); });
  }
  expect(normalizeWebSources(JSON.stringify({ ...sample, attempts }), { toolCallId: "search-1" })).toBeUndefined();
});

it("shows small sources immediately, folds larger cards and never invents a past switch for a live state", async () => {
  const receipt = normalizeWebSources(sample, { toolCallId: "search-1" })!;
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(<NativeWebSources receipt={receipt} />); });
  expect(root.root.findAllByProps({ accessibilityRole: "link" })).toHaveLength(1);
  await act(async () => { root.unmount(); });
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...receipt.sources[0], sourceId: "native-large-" + index }));
  await act(async () => { root = create(<NativeWebSources receipt={{ ...receipt, sources }} />); });
  expect(root.root.findAllByProps({ accessibilityRole: "link" })).toHaveLength(0);
  await act(async () => { root.unmount(); });
  await act(async () => { root = create(<NativeWebSources receipt={{ ...receipt, attempts, status: "running" as never }} />); });
  expect(root.root.findAllByProps({ testID: "native-source-switch" })).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

it("uses native disclosure, ten-row pages and honest reading/cache states", async () => {
  const receipt = normalizeWebSources(sample, { toolCallId: "search-1" })!;
  receipt.sources = Array.from({ length: 11 }, (_, index) => ({ ...receipt.sources[0], sourceId: `native-${index}`, title: `Source ${index}`, cacheHit: true }));
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(<NativeWebSources receipt={receipt} />); });
  expect(JSON.stringify(root.toJSON())).not.toContain("Source 0");
  await act(async () => { root.root.findByProps({ testID: "native-sources-toggle-search-1" }).props.onPress(); });
  expect(root.root.findAllByProps({ accessibilityRole: "link" })).toHaveLength(10);
  expect(JSON.stringify(root.toJSON())).toContain("web_sources.read_summary_only");
  expect(JSON.stringify(root.toJSON())).toContain("web_sources.cached");
  expect(JSON.stringify(root.toJSON())).toContain("2026-10-30");
  expect(JSON.stringify(root.toJSON())).toContain("2026-10-31T00:00:00Z");
  await act(async () => { root.root.findByProps({ accessibilityLabel: "web_sources.next" }).props.onPress(); });
  expect(root.root.findAllByProps({ accessibilityRole: "link" })).toHaveLength(1);
  expect(JSON.stringify(root.toJSON())).toContain("Source 10");
  await act(async () => { root.unmount(); });
});

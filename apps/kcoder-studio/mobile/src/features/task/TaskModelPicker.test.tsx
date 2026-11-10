import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, expect, test, vi } from "vitest";

vi.hoisted(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
vi.mock("react-native", () => ({ ...Object.fromEntries(["ActivityIndicator", "Modal", "Pressable", "ScrollView", "Text", "View"].map(name => [name, name])), Platform: { OS: "web" } }));
vi.mock("lucide-react-native", () => ({ ChevronLeft: "ChevronLeft", ChevronRight: "ChevronRight", X: "X" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/theme", () => ({ spacing: { lg: 16 } }));
vi.mock("@/runtime/task-runtime", () => ({ modelOptionSelector: (item: { id: string }) => item.id }));
vi.mock("@/storage/new-workspace-preferences", () => ({ reasoningEffortLabel: (value: string) => value }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: { textMuted: "gray" } }) }));
import { initLocale } from "@/i18n";
import { TaskModelPicker } from "./TaskModelPicker";

const options = [
  { id: "p::a", model: "a", providerId: "p", displayName: "A", providerName: "P", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
  { id: "p::b", model: "b", providerId: "p", displayName: "B", providerName: "P", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
  { id: "p::plain", model: "plain", providerId: "p", displayName: "Plain", providerName: "P" },
];
const makeModel = (index = 0) => ({ bottomInset: 0, snapshot: { model: options[index].id, reasoningEffort: "high" }, modelOptions: options,
  modelsLoading: false, modelBusy: false, modelError: null as string | null, closeModelPicker: vi.fn(),
  selectedModelOption: options[index], applyTurnPreferences: vi.fn(async () => true) });
let renderer: TestRenderer.ReactTestRenderer;
const hosts = (id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.type === "string");
const press = async (id: string) => { await act(async () => hosts(id)[0].props.onPress()); };
const mount = async (model: ReturnType<typeof makeModel>) => { await act(async () => { renderer = TestRenderer.create(<TaskModelPicker model={model as never} />); }); };
beforeEach(() => initLocale("en"));

test("reasoning exists only in details; opening the current model does not write preferences", async () => {
  const model = makeModel(); await mount(model);
  expect(hosts("conversation-model-efforts")).toHaveLength(0);
  expect(renderer.root.findAll(node => String(node.type) === "Text" && node.props.children === "✓")).toHaveLength(0);
  await press("conversation-model-details-p::a");
  expect(hosts("conversation-model-list")).toHaveLength(0);
  expect(hosts("conversation-model-effort-high")[0].props["aria-checked"]).toBe(true);
  expect(model.applyTurnPreferences).not.toHaveBeenCalled();
  await press("conversation-model-effort-low");
  expect(model.applyTurnPreferences).toHaveBeenCalledExactlyOnceWith("p::a", "low");
  await press("conversation-model-back");
  expect(hosts("conversation-model-list")).toHaveLength(1);
  expect(hosts("conversation-model-efforts")).toHaveLength(0);
  await press("conversation-model-p::b");
  expect(model.applyTurnPreferences).toHaveBeenLastCalledWith("p::b", "low");
  expect(model.closeModelPicker).toHaveBeenCalledExactlyOnceWith();
  expect(hosts("conversation-model-details")).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test("choosing the already selected model closes without writing preferences", async () => {
  const model = makeModel(); await mount(model);
  await press("conversation-model-p::a");
  expect(model.applyTurnPreferences).not.toHaveBeenCalled();
  expect(model.closeModelPicker).toHaveBeenCalledExactlyOnceWith();
  await act(async () => renderer.unmount());
});

test("a list choice closes only after its asynchronous save succeeds", async () => {
  const model = makeModel();
  let finish!: (saved: boolean) => void;
  model.applyTurnPreferences.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(model); await press("conversation-model-p::b");
  expect(model.applyTurnPreferences).toHaveBeenCalledExactlyOnceWith("p::b", "low");
  expect(model.closeModelPicker).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(model.closeModelPicker).toHaveBeenCalledExactlyOnceWith();
  await act(async () => renderer.unmount());
});

test("a failed list choice retains the picker and its error instead of dismissing it", async () => {
  const model = makeModel(); model.applyTurnPreferences.mockResolvedValueOnce(false);
  await mount(model); await press("conversation-model-p::b");
  model.modelError = "selection was rejected";
  await act(async () => renderer.update(<TaskModelPicker model={model as never} />));
  expect(model.closeModelPicker).not.toHaveBeenCalled();
  expect(hosts("conversation-model-p::a")[0].props["aria-checked"]).toBe(true);
  expect(renderer.root.findAllByProps({ accessibilityRole: "alert" })[0].props.children).toBe("selection was rejected");
  await act(async () => renderer.unmount());
});

test("a save completing after the picker has unmounted cannot dismiss a replacement", async () => {
  const model = makeModel();
  let finish!: (saved: boolean) => void;
  model.applyTurnPreferences.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(model); await press("conversation-model-p::b");
  await act(async () => renderer.unmount());
  await act(async () => finish(true));
  expect(model.closeModelPicker).not.toHaveBeenCalled();
});

test("a failed switch keeps the attempted model identifiable, without applying its effort to the previous model", async () => {
  const model = makeModel(); await mount(model);
  await press("conversation-model-details-p::b");
  expect(model.applyTurnPreferences).toHaveBeenCalledExactlyOnceWith("p::b", "low");
  expect(hosts("conversation-model-efforts")).toHaveLength(0);
  model.modelError = "selection was rejected";
  await act(async () => renderer.update(<TaskModelPicker model={model as never} />));
  expect(renderer.root.findAllByProps({ accessibilityRole: "alert" })[0].props.children).toBe("selection was rejected");
  await press("conversation-model-retry");
  expect(model.applyTurnPreferences).toHaveBeenLastCalledWith("p::b", "low");
  await press("conversation-model-back");
  expect(hosts("conversation-model-p::a")[0].props["aria-checked"]).toBe(true);
  expect(hosts("conversation-model-p::b")[0].props["aria-checked"]).toBe(false);
  await act(async () => renderer.unmount());
});

test("confirmed and pending preferences determine effort checks, and busy navigation cannot dismiss a write", async () => {
  const model = makeModel(); await mount(model); await press("conversation-model-details-p::a");
  const pending = { ...model, modelBusy: true, snapshot: { ...model.snapshot, pendingTurnPreferences: { model: "p::a", reasoningEffort: "low" } } };
  await act(async () => renderer.update(<TaskModelPicker model={pending as never} />));
  expect(hosts("conversation-model-effort-low")[0].props["aria-checked"]).toBe(true);
  expect(hosts("conversation-model-effort-high")[0].props.disabled).toBe(true);
  await press("conversation-model-back"); await press("conversation-model-close");
  expect(hosts("conversation-model-details")).toHaveLength(1);
  expect(model.closeModelPicker).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test("models without effort choices have a truthful detail view, with no invented choices", async () => {
  const model = makeModel(2); await mount(model); await press("conversation-model-details-p::plain");
  expect(hosts("conversation-model-no-efforts")).toHaveLength(1);
  expect(hosts("conversation-model-efforts")).toHaveLength(0);
  expect(model.applyTurnPreferences).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

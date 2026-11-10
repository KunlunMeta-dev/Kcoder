// Actual Welcome route handlers with deterministic hooks; no browser or native host.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { initLocale, t } from "@/i18n";
import { GatewayHttpError } from "@/gateway/http-errors";
import appJson from "../../../app.json";

type Effect = { deps: readonly unknown[]; cleanup?: () => void };
const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as Effect[],
  pending: [] as Array<() => void>, stateIndex: 0, refIndex: 0, effectIndex: 0,
  params: {} as Record<string, string | string[] | undefined>, platform: { OS: "web" },
  hydrationError: null as string | null,
  connect: vi.fn<(input: { baseUrl: string; token: string; signal: AbortSignal }) => Promise<{ id: string } | null>>(),
  retry: vi.fn(), router: { replace: vi.fn(), push: vi.fn(), setParams: vi.fn() },
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) {
      const index = host.stateIndex++;
      if (!(index in host.states)) host.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [host.states[index], (value: unknown) => { host.states[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(host.states[index]) : value; }];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
      const index = host.effectIndex++; const previous = host.effects[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      host.pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); host.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
    },
  };
});
vi.mock("expo-router", () => ({ useLocalSearchParams: () => host.params, useRouter: () => host.router }));
vi.mock("react-native", () => ({ Platform: host.platform, KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (value: unknown) => value } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ClipboardPaste", "Link2", "QrCode", "Settings", "X"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", Field: "Field" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ connectGateway: host.connect, retryStoredProfiles: host.retry, profileHydrationError: host.hydrationError }) }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), radius: {}, spacing: {} }));
import WelcomeRoute from "../welcome";

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown, visibleOnly = false): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, visibleOnly));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...(visibleOnly && element.props.visible === false ? [] : elements(element.props.children, visibleOnly))];
}
function byId(tree: unknown, id: string): Element { return elements(tree, true).find(element => element.props.testID === id)!; }
function modal(tree: unknown, fieldId: string): Element { return elements(tree).find(element => element.props.initialFocus === `[data-testid="${fieldId}"]`)!; }
function text(node: unknown): string { if (typeof node === "string") return node; if (Array.isArray(node)) return node.map(text).join(" "); return isValidElement(node) ? text((node as Element).props.children) : ""; }
function render() { host.stateIndex = host.refIndex = host.effectIndex = 0; host.pending = []; const tree = WelcomeRoute(); for (const effect of host.pending) effect(); return tree; }
function cleanup() { for (const effect of host.effects) effect.cleanup?.(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; }
function openManual() { byId(render(), "welcome-direct-connection").props.onPress(); const tree = render(); byId(tree, "gateway-endpoint").props.onChangeText("https://gateway.invalid"); byId(tree, "gateway-token").props.onChangeText("synthetic-token"); return render(); }
beforeEach(() => {
  host.states = []; host.refs = []; host.effects = []; host.pending = []; host.params = {}; host.platform.OS = "web";
  host.hydrationError = null;
  host.connect.mockReset(); host.retry.mockReset(); host.router.replace.mockReset(); host.router.push.mockReset(); host.router.setParams.mockReset();
  host.router.setParams.mockImplementation((params: Record<string, string | undefined>) => { host.params = { ...host.params, ...params }; });
  initLocale("en"); vi.stubGlobal("location", { origin: "https://gateway.invalid", pathname: "/mobile/welcome" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("hands a committed manual connection to Home before navigation cleanup", async () => {
  const connected = deferred<{ id: string } | null>(); host.connect.mockReturnValue(connected.promise);
  host.router.replace.mockImplementation(() => cleanup());
  byId(openManual(), "gateway-connect").props.onPress();
  const input = host.connect.mock.calls[0]![0];
  expect(input).toMatchObject({ baseUrl: "https://gateway.invalid", token: "synthetic-token" });
  connected.resolve({ id: "stable-existing-profile" });
  await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "stable-existing-profile" } }));
  expect(input.signal.aborted).toBe(false);
});

it("aborts an unfinished connection on modal close and ignores its late result", async () => {
  const connected = deferred<{ id: string } | null>(); host.connect.mockReturnValue(connected.promise);
  byId(openManual(), "gateway-connect").props.onPress();
  modal(render(), "gateway-endpoint").props.onClose();
  expect(host.connect.mock.calls[0]![0].signal.aborted).toBe(true);
  connected.resolve({ id: "stale" }); await connected.promise; await Promise.resolve();
  expect(host.router.replace).not.toHaveBeenCalled();
});

it.each(["en", "zh-CN"] as const)("%s exposes paste as the Web primary action and keeps manual fields in their modal", locale => {
  initLocale(locale); const tree = render();
  expect(text(tree)).toContain(`KCoder Studio Mobile ${appJson.expo.version}`);
  expect(byId(tree, "welcome-scan-qr")).toBeUndefined();
  expect(byId(tree, "welcome-paste-pairing-link").props.variant).toBe("primary");
  expect(byId(tree, "welcome-direct-connection").props.variant).toBe("ghost");
  expect(text(byId(tree, "welcome-direct-connection")).trim()).toBe(t("welcome.direct_connect"));
  expect(byId(tree, "gateway-endpoint")).toBeUndefined();
  byId(tree, "welcome-paste-pairing-link").props.onPress();
  expect(modal(render(), "pair-link-input").props.visible).toBe(true);
  expect(byId(render(), "pair-link-input").props.autoCorrect).toBe(false);
});
it.each(["android", "ios"])("uses native scanning as the %s primary action with paste and manual alternatives", platform => {
  host.platform.OS = platform; const tree = render();
  expect(byId(tree, "welcome-scan-qr").props.variant).toBe("primary");
  expect(byId(tree, "welcome-paste-pairing-link").props.variant).toBe("ghost");
  byId(tree, "welcome-scan-qr").props.onPress();
  expect(host.router.push).toHaveBeenCalledWith("/pair-scan");
  expect(host.connect).not.toHaveBeenCalled();
});
it("consumes the fallback UI parameter, directly opens paste and does not reopen it after dismissal", () => {
  host.params = { connectMode: "pairing" }; render();
  const tree = render();
  expect(modal(tree, "pair-link-input").props.visible).toBe(true);
  expect(modal(tree, "gateway-endpoint").props.visible).toBe(false);
  expect(host.router.setParams).toHaveBeenCalledWith({ connectMode: undefined });
  modal(tree, "pair-link-input").props.onClose();
  expect(modal(render(), "pair-link-input").props.visible).toBe(false);
  expect(host.router.setParams).toHaveBeenCalledTimes(1);
});
it("opens the manual form immediately for an explicit direct-connection route and consumes the mode", () => {
  host.params = { connectMode: "direct" };
  const tree = render();
  expect(modal(tree, "gateway-endpoint").props.visible).toBe(true);
  expect(modal(tree, "pair-link-input").props.visible).toBe(false);
  expect(host.router.setParams).toHaveBeenCalledWith({ connectMode: undefined });
});
it("keeps explicit reauthorization on the manual path despite a fallback UI parameter", () => {
  host.params = { gateway: "https://relay.invalid/g/saved", reauth: "saved-profile", connectMode: "pairing" };
  render(); const tree = render();
  expect(modal(tree, "gateway-endpoint").props.visible).toBe(true);
  expect(modal(tree, "pair-link-input").props.visible).toBe(false);
  expect(byId(tree, "gateway-endpoint").props.value).toBe("https://relay.invalid/g/saved");
  expect(host.connect).not.toHaveBeenCalled();
});
it("gives reauthorization precedence over direct-open presentation parameters", () => {
  host.params = { gateway: "https://relay.invalid/g/saved", reauth: "saved-profile", connectMode: "direct" };
  render(); const tree = render();
  expect(modal(tree, "gateway-endpoint").props.visible).toBe(true);
  expect(modal(tree, "pair-link-input").props.visible).toBe(false);
  expect(byId(tree, "gateway-endpoint").props.value).toBe("https://relay.invalid/g/saved");
  expect(host.router.setParams).toHaveBeenCalledWith({ connectMode: undefined });
  expect(host.connect).not.toHaveBeenCalled();
});
it("uses the first gateway and reauthorization values when route query keys repeat", () => {
  host.params = {
    gateway: ["https://relay.invalid/g/saved", "https://other.invalid"],
    reauth: ["saved-profile", "other-profile"],
  };
  render(); const tree = render();
  expect(modal(tree, "gateway-endpoint").props.visible).toBe(true);
  expect(byId(tree, "gateway-endpoint").props.value).toBe("https://relay.invalid/g/saved");
  expect(host.connect).not.toHaveBeenCalled();
});
it("initializes the manual endpoint from the current Relay mount without resetting user edits", () => {
  vi.stubGlobal("location", { origin: "https://relay.invalid", pathname: "/g/saved/mobile/welcome" });
  render(); byId(render(), "welcome-direct-connection").props.onPress();
  expect(byId(render(), "gateway-endpoint").props.value).toBe("https://relay.invalid/g/saved");
  byId(render(), "gateway-endpoint").props.onChangeText("https://user-choice.invalid");
  expect(byId(render(), "gateway-endpoint").props.value).toBe("https://user-choice.invalid");
});
it("retains the visible paste draft across parse errors, network failures and modal reopening", async () => {
  byId(render(), "welcome-paste-pairing-link").props.onPress();
  byId(render(), "pair-link-input").props.onChangeText("invalid pairing draft");
  byId(render(), "pair-link-connect").props.onPress();
  expect(host.connect).not.toHaveBeenCalled();
  expect(byId(render(), "pair-link-input").props.value).toBe("invalid pairing draft");
  const draft = "kcoder-studio://connect?gateway=https%3A%2F%2Frelay.invalid%2Fg%2Fsaved&token=synthetic";
  byId(render(), "pair-link-input").props.onChangeText(draft);
  host.connect.mockRejectedValue(new Error("Gateway unavailable"));
  byId(render(), "pair-link-connect").props.onPress();
  await vi.waitFor(() => expect(text(render())).toContain("Gateway unavailable"));
  expect(host.connect.mock.calls[0]![0]).toMatchObject({ baseUrl: "https://relay.invalid/g/saved", token: "synthetic" });
  expect(byId(render(), "pair-link-input").props.value).toBe(draft);
  modal(render(), "pair-link-input").props.onClose();
  byId(render(), "welcome-paste-pairing-link").props.onPress();
  expect(byId(render(), "pair-link-input").props.value).toBe(draft);
});
it("hands a pasted connection to the authoritative returned profile ID without cancelling it", async () => {
  host.connect.mockResolvedValue({ id: "coordinator-existing-id" }); host.router.replace.mockImplementation(cleanup);
  byId(render(), "welcome-paste-pairing-link").props.onPress();
  byId(render(), "pair-link-input").props.onChangeText("kcoder-studio://connect?gateway=https%3A%2F%2Fgateway.invalid&token=synthetic");
  byId(render(), "pair-link-connect").props.onPress();
  await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "coordinator-existing-id" } }));
  expect(host.connect.mock.calls[0]![0].signal.aborted).toBe(false);
});
it("retains manual address and token drafts after a failed request", async () => {
  host.connect.mockRejectedValue(new Error("Connection refused"));
  byId(openManual(), "gateway-connect").props.onPress();
  await vi.waitFor(() => expect(text(render())).toContain("Connection refused"));
  expect(byId(render(), "gateway-endpoint").props.value).toBe("https://gateway.invalid");
  expect(byId(render(), "gateway-token").props.value).toBe("synthetic-token");
  expect(byId(render(), "gateway-token").props.editable).toBe(true);
});
it("keeps useful HTTP error detail and recovery guidance visible while folding the raw status", async () => {
  host.connect.mockRejectedValue(new GatewayHttpError(429, "Device limit reached"));
  byId(openManual(), "gateway-connect").props.onPress();
  await vi.waitFor(() => {
    const tree = render();
    expect(text(tree)).toContain("Device limit reached");
    expect(text(tree)).toContain(t("connect.http_rate_limited"));
    expect(text(tree)).not.toContain(t("connect.http_status_detail", { status: 429 }));
  });
  byId(render(), "gateway-http-error-details-toggle").props.onPress();
  expect(text(render())).toContain(t("connect.http_status_detail", { status: 429 }));
});
it("deduplicates submission even before the loading state rerenders", async () => {
  const connected = deferred<{ id: string } | null>(); host.connect.mockReturnValue(connected.promise);
  const submit = byId(openManual(), "gateway-connect"); submit.props.onPress(); submit.props.onPress();
  expect(host.connect).toHaveBeenCalledTimes(1);
  expect(byId(render(), "gateway-endpoint").props.editable).toBe(false);
  connected.resolve(null); await connected.promise; await Promise.resolve();
  expect(text(render())).toContain(t("welcome.connection_superseded"));
  expect(host.router.replace).not.toHaveBeenCalled();
});
it.each(["success", "failure"] as const)("rejects a late %s after the gateway/reauthorization route owner changes", async outcome => {
  const connected = deferred<{ id: string } | null>(); host.connect.mockReturnValue(connected.promise);
  host.params = { gateway: "https://old.invalid", reauth: "old-profile" };
  byId(openManual(), "gateway-connect").props.onPress();
  host.params = { gateway: "https://new.invalid", reauth: "new-profile" }; render(); const tree = render();
  expect(host.connect.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(byId(tree, "gateway-endpoint").props.value).toBe("https://new.invalid");
  expect(byId(tree, "gateway-token").props.value).toBe("");
  if (outcome === "success") connected.resolve({ id: "old-profile" }); else connected.reject(new Error("Old error"));
  await connected.promise.catch(() => {}); await Promise.resolve();
  expect(host.router.replace).not.toHaveBeenCalled(); expect(text(render())).not.toContain("Old error");
});
it("does not let an old attempt settle a newer connection after the modal is closed and reopened", async () => {
  const old = deferred<{ id: string } | null>(); const current = deferred<{ id: string } | null>();
  host.connect.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  byId(openManual(), "gateway-connect").props.onPress(); modal(render(), "gateway-endpoint").props.onClose();
  byId(openManual(), "gateway-connect").props.onPress();
  old.resolve({ id: "old" }); await old.promise; await Promise.resolve();
  expect(byId(render(), "gateway-connect").props.loading).toBe(true); expect(host.router.replace).not.toHaveBeenCalled();
  current.resolve({ id: "current" }); await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "current" } }));
});
it("does not navigate with a restored profile after a different route owner takes over", async () => {
  const restored = deferred<string | null>(); host.retry.mockReturnValue(restored.promise);
  host.hydrationError = "Local recovery failed";
  byId(render(), "retry-stored-profiles").props.onPress();
  expect(host.retry).toHaveBeenCalledTimes(1);
  host.params = { gateway: "https://another.invalid", reauth: "another-profile" }; render();
  restored.resolve("previous-profile"); await restored.promise; await Promise.resolve();
  expect(host.router.replace).not.toHaveBeenCalled();
  expect(host.connect).not.toHaveBeenCalled();
});

// Actual scanner route handlers with a camera adapter stub; not physical QR acceptance.
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { initLocale } from "@/i18n";

type Effect = { deps: readonly unknown[]; cleanup?: () => void };
const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as Effect[], pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0, platform: { OS: "android" },
  permission: { granted: true, canAskAgain: true }, requestPermission: vi.fn(), hardwareBack: null as (() => boolean) | null,
  connect: vi.fn<(input: { baseUrl: string; token: string; signal: AbortSignal }) => Promise<{ id: string } | null>>(),
  router: { replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true) },
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) { const index = host.stateIndex++; if (!(index in host.states)) host.states[index] = initial; return [host.states[index], (value: unknown) => { host.states[index] = typeof value === "function" ? (value as (old: unknown) => unknown)(host.states[index]) : value; }]; },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
      const index = host.effectIndex++; const previous = host.effects[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      host.pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); host.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
    },
  };
});
vi.mock("expo-router", () => ({ useRouter: () => host.router }));
vi.mock("react-native", () => ({ Platform: host.platform, ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { create: (value: unknown) => value }, BackHandler: { addEventListener: (_event: string, handler: () => boolean) => { host.hardwareBack = handler; return { remove: () => { host.hardwareBack = null; } }; } } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronLeft", "Flashlight", "QrCode", "RotateCcw"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ connectGateway: host.connect }) }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), radius: {}, spacing: {} }));

const require = createRequire(import.meta.url);
const cameraPath = require.resolve("expo-camera");
const previousCamera = require.cache[cameraPath];
require.cache[cameraPath] = { id: cameraPath, filename: cameraPath, loaded: true, exports: { CameraView: "CameraView", useCameraPermissions: () => [host.permission, host.requestPermission] } } as NodeModule;
afterAll(() => { if (previousCamera) require.cache[cameraPath] = previousCamera; else delete require.cache[cameraPath]; });
import PairScanRoute from "../pair-scan";
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!isValidElement(node)) return []; const element = node as Element; return [element, ...elements(element.props.children)]; }
function byId(tree: unknown, id: string): Element | undefined { return elements(tree).find(element => element.props.testID === id); }
function render() { host.stateIndex = host.refIndex = host.effectIndex = 0; host.pending = []; const component = PairScanRoute() as ReactElement; const tree = (component.type as () => unknown)(); for (const effect of host.pending) effect(); return tree; }
function cleanup() { for (const effect of host.effects) effect.cleanup?.(); }
const pairing = "kcoder-studio://connect?gateway=https%3A%2F%2Fgateway.invalid&token=synthetic-token";
beforeEach(() => {
  host.states = []; host.refs = []; host.effects = []; host.pending = []; host.platform.OS = "android"; host.permission = { granted: true, canAskAgain: true }; host.hardwareBack = null;
  host.connect.mockReset(); host.requestPermission.mockReset(); host.router.replace.mockReset(); host.router.dismissTo.mockReset(); host.router.back.mockReset(); host.router.canGoBack.mockReturnValue(true); initLocale("en");
});
afterEach(cleanup);
it("releases the scanner and hands pairing to the same connect route as a deep link", () => {
  host.router.replace.mockImplementation(() => cleanup());
  byId(render(), "pairing-camera")!.props.onBarcodeScanned({ data: pairing });
  expect(host.router.replace).toHaveBeenCalledWith("/connect?gateway=https%3A%2F%2Fgateway.invalid&token=synthetic-token");
  expect(host.connect).not.toHaveBeenCalled();
});
it("ignores a late camera callback after unmount", () => {
  const scan = byId(render(), "pairing-camera")!.props.onBarcodeScanned;
  cleanup(); scan({ data: pairing });
  expect(host.connect).not.toHaveBeenCalled();
  expect(host.router.replace).not.toHaveBeenCalled();
});
it("keeps accepted HTTPS pairing QR payloads inside the common connection page", () => {
  const input = pairing.replace("kcoder-studio://", "https://");
  byId(render(), "pairing-camera")!.props.onBarcodeScanned({ data: input });
  expect(host.router.replace).toHaveBeenCalledWith("/connect?gateway=https%3A%2F%2Fgateway.invalid&token=synthetic-token");
  expect(host.connect).not.toHaveBeenCalled();
});
it("keeps Web free of native camera/permission controls and links directly to paste", () => {
  host.platform.OS = "web"; const tree = render();
  expect(byId(tree, "pairing-camera")).toBeUndefined(); expect(byId(tree, "request-camera-permission")).toBeUndefined();
  byId(tree, "pairing-web-paste-link")!.props.onPress();
  expect(host.router.dismissTo).toHaveBeenCalledWith({ pathname: "/welcome", params: { connectMode: "pairing" } });
  expect(host.connect).not.toHaveBeenCalled(); expect(host.hardwareBack).toBeNull();
});
it.each([true, false])("offers paste when camera permission is denied (canAskAgain=%s)", canAskAgain => {
  host.permission = { granted: false, canAskAgain }; const tree = render();
  expect(byId(tree, "pairing-camera")).toBeUndefined();
  byId(tree, "pairing-native-paste-link")!.props.onPress();
  expect(host.router.dismissTo).toHaveBeenCalledWith({ pathname: "/welcome", params: { connectMode: "pairing" } });
  expect(host.connect).not.toHaveBeenCalled();
});
it("ignores duplicate barcode callbacks after handing off pairing", () => {
  const scan = byId(render(), "pairing-camera")!.props.onBarcodeScanned;
  scan({ data: pairing }); scan({ data: pairing });
  expect(host.router.replace).toHaveBeenCalledTimes(1);
  expect(host.connect).not.toHaveBeenCalled();
  expect(byId(render(), "pairing-camera")!.props.onBarcodeScanned).toBeUndefined();
});
it.each(["header", "hardware"] as const)("leaves synchronously on %s back and ignores a late scan", action => {
  const tree = render(); const scan = byId(tree, "pairing-camera")!.props.onBarcodeScanned;
  if (action === "hardware") expect(host.hardwareBack!()).toBe(true);
  else elements(tree).find(element => element.props.accessibilityLabel === "Back")!.props.onPress();
  expect(host.router.back).toHaveBeenCalledTimes(1);
  scan({ data: pairing });
  expect(host.router.replace).not.toHaveBeenCalled();
  expect(host.connect).not.toHaveBeenCalled();
});
it("uses the welcome fallback when a cold scanner has no navigation history", () => {
  host.router.canGoBack.mockReturnValue(false); render(); host.hardwareBack!();
  expect(host.router.replace).toHaveBeenCalledWith("/welcome");
});
it("requires an explicit scan-again action after a parse error and then accepts a new scan", () => {
  const scan = byId(render(), "pairing-camera")!.props.onBarcodeScanned;
  scan({ data: "not a pairing link" }); scan({ data: pairing });
  expect(host.connect).not.toHaveBeenCalled(); expect(byId(render(), "pairing-camera")!.props.onBarcodeScanned).toBeUndefined();
  byId(render(), "scan-again")!.props.onPress();
  byId(render(), "pairing-camera")!.props.onBarcodeScanned({ data: pairing });
  expect(host.router.replace).toHaveBeenCalledWith("/connect?gateway=https%3A%2F%2Fgateway.invalid&token=synthetic-token");
  expect(host.connect).not.toHaveBeenCalled();
});
it("preserves the QR route descriptor and mount identity in the common native connection route", () => {
  const gateway = "https://gateway.invalid/g/test-route";
  const routes = { version: 1, gatewayId: "a".repeat(64), publicKey: "b".repeat(64), endpoints: [{ kind: "public", url: gateway }] };
  const input = new URL(pairing);
  input.searchParams.set("gateway", gateway);
  input.searchParams.set("gatewayId", "test-route");
  input.searchParams.set("routes", JSON.stringify(routes));
  byId(render(), "pairing-camera")!.props.onBarcodeScanned({ data: input.toString() });
  const destination = new URL(host.router.replace.mock.calls[0]![0], "https://fixture.invalid");
  expect(destination.pathname).toBe("/connect");
  expect(destination.searchParams.get("gateway")).toBe(gateway);
  expect(destination.searchParams.get("gatewayId")).toBe("test-route");
  expect(JSON.parse(destination.searchParams.get("routes")!)).toEqual(routes);
  expect(host.connect).not.toHaveBeenCalled();
});

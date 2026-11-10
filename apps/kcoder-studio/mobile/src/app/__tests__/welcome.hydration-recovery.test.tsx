// Actual WelcomeRoute props/handlers with deterministic hooks; not mounted UI.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { getLocalePreference, setLocalePreference, t, type LocalePreference } from "@/i18n";
const api = vi.hoisted(() => ({
  retry: vi.fn<() => Promise<string | null>>(), connect: vi.fn(), replace: vi.fn(),
  error: null as string | null, retrying: false, params: {} as Record<string, string>,
  refs: [] as Array<{ current: unknown }>, refIndex: 0,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (value: unknown) => [value, vi.fn()],
    useRef: (current: unknown) => {
      const index = api.refIndex++;
      return api.refs[index] ??= { current };
    },
    useEffect: vi.fn(),
  };
});
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ connectGateway: api.connect, profileHydrationError: api.error, profileHydrationRetrying: api.retrying, retryStoredProfiles: api.retry }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: api.replace, push: vi.fn() }), useLocalSearchParams: () => api.params }));
vi.mock("react-native", () => ({ KeyboardAvoidingView: "keyboard", Modal: "modal", Platform: { OS: "web" }, Pressable: "pressable", ScrollView: "scroll", Text: "text", View: "view", StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock("lucide-react-native", () => ({ ClipboardPaste: "icon", Link2: "icon", QrCode: "icon", Settings: "icon", X: "icon" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@/components/ui", () => ({ Button: "button", Field: "field" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: vi.fn() }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  };
});
import WelcomeRoute from "../welcome";
let preferredLocale: LocalePreference = "system";
function renderWelcome() { api.refIndex = 0; return WelcomeRoute(); }
function nodeWithId(node: ReactNode, id: string): ReactElement<{ testID: string; disabled?: boolean; onPress(): void; children?: ReactNode }> | undefined {
  if (Array.isArray(node)) return node.map(child => nodeWithId(child, id)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<{ testID: string; disabled?: boolean; onPress(): void; children?: ReactNode }>;
  return element.props.testID === id ? element : nodeWithId(element.props.children, id);
}
function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}
beforeEach(() => { vi.clearAllMocks(); preferredLocale = getLocalePreference(); setLocalePreference("en"); api.error = "原配置已保留"; api.retrying = false; api.params = {}; api.refs = []; api.refIndex = 0; api.retry.mockResolvedValue(null); });
afterEach(() => setLocalePreference(preferredLocale));
it("binds the recoverable banner to a local retry and leaves pairing untouched on failure", async () => {
  const tree = renderWelcome(); const banner = nodeWithId(tree, "stored-profile-hydration-error"); expect(banner).toBeDefined();
  expect(textContent(banner)).toContain("原配置已保留");
  nodeWithId(tree, "retry-stored-profiles")!.props.onPress();
  await vi.waitFor(() => expect(api.retry).toHaveBeenCalledOnce());
  expect(api.connect).not.toHaveBeenCalled(); expect(api.replace).not.toHaveBeenCalled();
});
it("localizes the saved-connection fallback and recovery labels for the preferred locale", () => {
  api.error = null;
  api.retrying = true;
  const loadingBanner = nodeWithId(renderWelcome(), "stored-profile-hydration-error");
  expect(textContent(loadingBanner)).toContain(t("welcome.loading_local_connection_config"));
  expect(textContent(loadingBanner)).toContain(t("task.recovering"));

  api.error = "Raw profile hydration error";
  api.retrying = false;
  const retryBanner = nodeWithId(renderWelcome(), "stored-profile-hydration-error");
  expect(textContent(retryBanner)).toContain("Raw profile hydration error");
  expect(textContent(retryBanner)).toContain(t("welcome.retry_local_recovery"));
});
it("navigates once with the restored profile ID and rejects duplicate clicks while the local retry is held", async () => {
  let resolve!: (id: string | null) => void; api.retry.mockReturnValue(new Promise(r => { resolve = r; }));
  const button = nodeWithId(renderWelcome(), "retry-stored-profiles")!;
  button.props.onPress(); button.props.onPress(); expect(api.retry).toHaveBeenCalledOnce();
  resolve("restored"); await vi.waitFor(() => expect(api.replace).toHaveBeenCalledOnce());
  expect(api.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "restored" } });
  expect(api.connect).not.toHaveBeenCalled();
});
it("disables the retry button during restoration", () => {
  api.retrying = true; expect(nodeWithId(renderWelcome(), "retry-stored-profiles")!.props.disabled).toBe(true);
});
it("keeps an explicit reauthorization route when recovery activates a different profile", async () => {
  api.params = { gateway: "https://gateway-a.invalid", reauth: "profile-a" };
  let resolve!: (id: string | null) => void;
  api.retry.mockReturnValue(new Promise(r => { resolve = r; }));
  nodeWithId(renderWelcome(), "retry-stored-profiles")!.props.onPress();
  resolve("profile-b");
  await Promise.resolve();
  expect(api.replace).not.toHaveBeenCalled();
});
it("navigates an explicit reauthorization route only when recovery restores its profile", async () => {
  api.params = { gateway: "https://gateway-a.invalid", reauth: "profile-a" };
  api.retry.mockResolvedValue("profile-a");
  nodeWithId(renderWelcome(), "retry-stored-profiles")!.props.onPress();
  await vi.waitFor(() => expect(api.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "profile-a" } }));
});
it("keeps an explicit gateway route when recovery returns an unverified active profile", async () => {
  api.params = { gateway: "https://gateway-a.invalid" };
  api.retry.mockResolvedValue("profile-b");
  nodeWithId(renderWelcome(), "retry-stored-profiles")!.props.onPress();
  await Promise.resolve();
  expect(api.replace).not.toHaveBeenCalled();
});
it("ignores a recovery result after the Welcome route owner changes", async () => {
  api.params = { gateway: "https://gateway-a.invalid", reauth: "profile-a" };
  let resolve!: (id: string | null) => void;
  api.retry.mockReturnValue(new Promise(r => { resolve = r; }));
  nodeWithId(renderWelcome(), "retry-stored-profiles")!.props.onPress();
  api.params = { gateway: "https://gateway-c.invalid", reauth: "profile-c" };
  renderWelcome();
  resolve("profile-a");
  await Promise.resolve();
  expect(api.replace).not.toHaveBeenCalled();
});

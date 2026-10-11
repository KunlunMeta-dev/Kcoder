// Actual WelcomeRoute props/handlers with deterministic hooks; not mounted UI.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { getLocalePreference, setLocalePreference, t, type LocalePreference } from "@/i18n";
const api = vi.hoisted(() => ({
  retry: vi.fn<() => Promise<string | null>>(), connect: vi.fn(), replace: vi.fn(),
  error: null as string | null, retrying: false,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }), useEffect: vi.fn() };
});
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ connectGateway: api.connect, profileHydrationError: api.error, profileHydrationRetrying: api.retrying, retryStoredProfiles: api.retry }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: api.replace, push: vi.fn() }), useLocalSearchParams: () => ({}) }));
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
beforeEach(() => { vi.clearAllMocks(); preferredLocale = getLocalePreference(); setLocalePreference("en"); api.error = "原配置已保留"; api.retrying = false; api.retry.mockResolvedValue(null); });
afterEach(() => setLocalePreference(preferredLocale));
it("binds the recoverable banner to a local retry and leaves pairing untouched on failure", async () => {
  const tree = WelcomeRoute(); const banner = nodeWithId(tree, "stored-profile-hydration-error"); expect(banner).toBeDefined();
  expect(textContent(banner)).toContain("原配置已保留");
  nodeWithId(tree, "retry-stored-profiles")!.props.onPress();
  await vi.waitFor(() => expect(api.retry).toHaveBeenCalledOnce());
  expect(api.connect).not.toHaveBeenCalled(); expect(api.replace).not.toHaveBeenCalled();
});
it("localizes the saved-connection fallback and recovery labels for the preferred locale", () => {
  api.error = null;
  api.retrying = true;
  const loadingBanner = nodeWithId(WelcomeRoute(), "stored-profile-hydration-error");
  expect(textContent(loadingBanner)).toContain(t("welcome.loading_local_connection_config"));
  expect(textContent(loadingBanner)).toContain(t("task.recovering"));

  api.error = "Raw profile hydration error";
  api.retrying = false;
  const retryBanner = nodeWithId(WelcomeRoute(), "stored-profile-hydration-error");
  expect(textContent(retryBanner)).toContain("Raw profile hydration error");
  expect(textContent(retryBanner)).toContain(t("welcome.retry_local_recovery"));
});
it("navigates once with the restored profile ID and rejects duplicate clicks while the local retry is held", async () => {
  let resolve!: (id: string | null) => void; api.retry.mockReturnValue(new Promise(r => { resolve = r; }));
  const button = nodeWithId(WelcomeRoute(), "retry-stored-profiles")!;
  button.props.onPress(); button.props.onPress(); expect(api.retry).toHaveBeenCalledOnce();
  resolve("restored"); await vi.waitFor(() => expect(api.replace).toHaveBeenCalledOnce());
  expect(api.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "restored" } });
  expect(api.connect).not.toHaveBeenCalled();
});
it("disables the retry button during restoration", () => {
  api.retrying = true; expect(nodeWithId(WelcomeRoute(), "retry-stored-profiles")!.props.disabled).toBe(true);
});

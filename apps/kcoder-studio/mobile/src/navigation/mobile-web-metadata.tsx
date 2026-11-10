import { useEffect } from "react";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { Platform } from "react-native";
import { getSettingsHubSection } from "@/components/settings/settings-sections";
import { useTranslation } from "@/i18n/use-translation";

type Translate = (key: string) => string;

const STATIC_ROUTE_TITLE_KEYS: Record<string, string> = {
  "/": "task.home",
  "/welcome": "welcome.title",
  "/connect": "connect.title",
  "/new": "task.new_task",
  "/settings": "common.settings",
  "/settings-connections": "settings.connections",
  "/settings-appearance": "settings.appearance_title",
  "/settings-terminal": "settings.terminal_settings",
  "/settings-diagnostics": "settings.connection_diagnostics",
  "/settings-about": "settings.about",
  "/sessions": "task.history",
  "/open-project": "task.add_project",
  "/pair-scan": "welcome.scan_qr",
  "/server-editor": "server_editor.title",
  "/host-details": "host_details.title",
};

/** Strip only a known Mobile deployment mount before matching Expo route names. */
export function normalizeMobileRoutePath(pathname: string): string {
  const pathEnd = pathname.search(/[?#]/);
  const pathOnly = pathEnd < 0 ? pathname : pathname.slice(0, pathEnd);
  const withLeadingSlash = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  const mount = /^(?:\/g\/[A-Za-z0-9_-]{1,64})?\/mobile(?=\/|$)/.exec(withLeadingSlash);
  if (mount) return withLeadingSlash.slice(mount[0].length) || "/";

  const sentinel = "/__kcoder_mobile_mount_v1__";
  if (withLeadingSlash === sentinel) return "/";
  if (withLeadingSlash.startsWith(`${sentinel}/`))
    return withLeadingSlash.slice(sentinel.length) || "/";
  return withLeadingSlash || "/";
}

/** Resolve titles from an allowlist so IDs and task content never enter metadata. */
export function getMobileRouteTitleKey(pathname: string, sectionId?: string): string {
  const routePath = normalizeMobileRoutePath(pathname);
  const staticTitleKey = STATIC_ROUTE_TITLE_KEYS[routePath];
  if (staticTitleKey) return staticTitleKey;

  if (routePath === "/settings-section") {
    return getSettingsHubSection(sectionId)?.labelKey ?? "settings_hub.unavailable_title";
  }

  const segments = routePath.split("/").filter(Boolean);
  if (segments[0] === "h" && segments.length === 2) return "task.home";
  if (segments[0] === "h" && segments.length === 3 && segments[2] === "inbox")
    return "inbox.title";
  if (segments[0] === "h" && segments.length === 5 && segments[2] === "task")
    return "task.fallback_title";

  return "not_found.title";
}

export function resolveMobileDocumentTitle(
  pathname: string,
  sectionId: string | undefined,
  translate: Translate,
): string {
  const routeTitle = translate(getMobileRouteTitleKey(pathname, sectionId));
  const productTitle = translate("settings.product_name");
  return `${routeTitle} · ${productTitle}`;
}

export function resolveMobileDocumentLanguage(language: string | undefined): string {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Mobile Web metadata is client-only; the HTML shell supplies a static SSR title. */
export default function MobileWebDocumentMetadata() {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ section?: string | string[] }>();
  const sectionId = Array.isArray(params.section) ? params.section[0] : params.section;
  const [translate, i18n] = useTranslation();
  const language = i18n.language;
  const title = resolveMobileDocumentTitle(pathname, sectionId, translate);
  const documentLanguage = resolveMobileDocumentLanguage(language);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.title = title;
    if (document.documentElement) document.documentElement.lang = documentLanguage;
  }, [title, documentLanguage]);

  return null;
}

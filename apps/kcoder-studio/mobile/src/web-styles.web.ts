import "./web.css";
import { getLocale, subscribeLocale } from "@/i18n";
import { getThemeSnapshot, subscribeTheme } from "@/theme";

function syncWebTheme(): void {
  if (typeof document === "undefined") return;
  const { colors, mode } = getThemeSnapshot();
  const root = document.documentElement;
  root.style.setProperty("--mobile-color-scheme", mode);
  root.style.colorScheme = mode;
  for (const [token, value] of Object.entries(colors)) {
    const cssToken = token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--mobile-color-${cssToken}`, value);
  }
  root.style.backgroundColor = colors.background;
  root.style.color = colors.text;
  if (document.body) {
    document.body.style.backgroundColor = colors.background;
    document.body.style.color = colors.text;
  }
}

function syncWebLocale(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = getLocale();
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const themeWindow = window as Window & {
    __kcoderMobileWebStylesCleanup?: () => void;
  };
  themeWindow.__kcoderMobileWebStylesCleanup?.();
  syncWebTheme();
  syncWebLocale();
  const unsubscribeTheme = subscribeTheme(syncWebTheme);
  const unsubscribeLocale = subscribeLocale(syncWebLocale);
  themeWindow.__kcoderMobileWebStylesCleanup = () => {
    unsubscribeTheme();
    unsubscribeLocale();
  };
}

export {};

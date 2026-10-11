import { getLocale, type Locale } from "./locale-state";
import { useTranslation } from "./use-translation";

/** Compatibility hook for components that only need a locale-driven rerender. */
export function useLocale(): Locale {
  useTranslation();
  return getLocale();
}

export { useTranslation } from "./use-translation";

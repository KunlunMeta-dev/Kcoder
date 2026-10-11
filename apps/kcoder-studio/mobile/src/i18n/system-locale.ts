import { getLocales } from "expo-localization";
import { Platform } from "react-native";

/** Read the latest locale tag from the browser or native system settings. */
export function getSystemLocaleTag(): string | undefined {
  if (Platform.OS === "web") {
    if (typeof navigator === "undefined") return undefined;
    return navigator.languages?.[0] || navigator.language || undefined;
  }

  try {
    const locale = getLocales()[0];
    return locale?.languageTag || locale?.languageCode || undefined;
  } catch {
    return undefined;
  }
}

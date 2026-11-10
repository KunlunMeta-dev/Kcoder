import { useSyncExternalStore } from "react";
import { getAppPreferencesSnapshot, subscribeAppPreferences, type InterfaceVersion } from "./app-preferences";

/** Device-local UI choice. Switching it preserves owners; V3 cold launch uses the draft fallback. */
const getVersion = (): InterfaceVersion => getAppPreferencesSnapshot().interfaceVersion;

export function useInterfaceVersion(): InterfaceVersion {
  return useSyncExternalStore(subscribeAppPreferences, getVersion, getVersion);
}

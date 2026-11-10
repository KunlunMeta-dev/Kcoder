import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { getConversationFontAssets } from "./conversation-font-assets";

type FontStatus = "idle" | "loading" | "ready" | "error";
let status: FontStatus = "idle";
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getConversationFontStatus = () => status;
function publish(next: FontStatus) {
  status = next;
  listeners.forEach(listener => listener());
}

// Load in the background: startup and conversation rendering always have a system fallback.
export function loadConversationFonts(): Promise<void> {
  if (loading) return loading;
  publish("loading");
  loading = Promise.resolve().then(async () => {
    const { FontDisplay, loadAsync } = await import("expo-font");
    const assets = getConversationFontAssets();
    await loadAsync({
      "Noto Sans SC": { uri: assets.regular, display: FontDisplay.SWAP },
      "Noto Sans SC Bold": { uri: assets.bold, display: FontDisplay.SWAP },
    });
    publish("ready");
  }).catch(async () => {
    publish("error");
    if (Platform.OS !== "web" || typeof document === "undefined" || typeof document.fonts?.load !== "function") return;
    // Expo's Web observer can time out while the browser is still downloading.
    // Verify actual loaded faces; Expo's CSS-rule cache does not prove readiness.
    const families = ["Noto Sans SC", "Noto Sans SC Bold"];
    try {
      const loaded = await Promise.all(families.map(family => document.fonts.load(`17px "${family}"`)));
      if (loaded.every((faces, index) => faces.some(face =>
        face.status === "loaded" && face.family.trim().replace(/^(['"])(.*)\1$/, "$2") === families[index],
      ))) publish("ready");
    } catch {
      // A real download failure keeps the system fallback without retrying.
    }
  });
  return loading;
}

export function useConversationFontStatus(): FontStatus {
  return useSyncExternalStore(subscribe, getConversationFontStatus, getConversationFontStatus);
}

import * as Clipboard from "expo-clipboard";
import { Platform, Share } from "react-native";

export type TranscriptActionResult = "success" | "dismissed" | "failed" | "unavailable";

export { visibleAssistantText } from "./transcript-body";

export async function copyAssistantText(
  value: string,
): Promise<TranscriptActionResult> {
  try {
    return (await Clipboard.setStringAsync(value)) ? "success" : "failed";
  } catch {
    return "failed";
  }
}

export function supportsAssistantSharing(): boolean {
  if (Platform.OS === "ios" || Platform.OS === "android") return true;
  return Platform.OS === "web" && typeof browserShare() === "function";
}

export async function shareAssistantText(
  value: string,
  title: string,
): Promise<TranscriptActionResult> {
  try {
    if (Platform.OS === "web") {
      const share = browserShare();
      if (!share) return "unavailable";
      await share.call(globalThis.navigator, { title, text: value });
      return "success";
    }
    if (Platform.OS !== "ios" && Platform.OS !== "android") return "unavailable";
    const result = await Share.share({ message: value, title });
    return result.action === Share.dismissedAction ? "dismissed" : "success";
  } catch (error) {
    return isAbortError(error) ? "dismissed" : "failed";
  }
}

function browserShare():
  | ((data: { title?: string; text: string }) => Promise<unknown>)
  | undefined {
  if (typeof globalThis.navigator === "undefined") return undefined;
  const candidate = globalThis.navigator as Navigator & {
    share?: (data: { title?: string; text: string }) => Promise<unknown>;
  };
  return candidate.share;
}

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

import { useMemo } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CachedSessionView } from "../../../mobile/src/features/task/CachedSessionView";
import { createCachedHistory } from "./history";

export default function CachedConversationFixture() {
  const params = new URLSearchParams(window.location.search);
  const english = params.get("language") === "en";
  const cached = useMemo(() => createCachedHistory(english, params.get("history") === "short"), []);
  const owner = useMemo(() => ({}), []);
  // Deliberately no AppProvider, startup routing, runtime or reconnection timer.
  return <SafeAreaProvider>
    <CachedSessionView cached={cached} owner={owner}
      offline={params.get("state") === "offline"}
      composerDraft={params.get("draft") === "empty" ? "" : english ? "Please adjust the spacing above the composer." : "请帮我调整输入区上方的间距。"}
      onBack={() => {}} onRetry={() => {}} topInset={0} bottomInset={0} />
  </SafeAreaProvider>;
}

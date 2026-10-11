import { t } from "@/i18n";
import { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import {
  acknowledgeConfirmedWorkspaceOperation, loadConfirmedWorkspaceOperationReceipt,
  type WorkspaceOperationReceiptHandle,
} from "@/storage/pending-workspace-operation";
import { useLocale } from "@/i18n/use-locale";
import { useTheme } from "@/theme";
import { useFormOwner, useFormState } from "./form-owner";

/** V2 retries verify scope before consuming the original receipt; they never mutate a workspace or create a thread. */
export function WorkspaceOperationBookkeeping({ profile, server, expectedResult, enabled }: {
  profile: GatewayProfile | null | undefined; server: KCoderServer | undefined; expectedResult: string | undefined; enabled: boolean;
}) {
  useLocale();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    workspaceBookkeeping?: string; operationReceiptId?: string; operationKind?: string; operationSourcePath?: string; operationReceiptVersion?: string;
  }>();
  const scope = profile && server ? threadListScopeKey(profile, server) : null;
  const owner = useFormOwner(JSON.stringify([scope, profile ? profileAuthorizationScopeKey(profile) : null, enabled, expectedResult, params.operationReceiptId, params.operationKind, params.operationSourcePath, params.operationReceiptVersion]));
  const [receipt, setReceipt] = useFormState<WorkspaceOperationReceiptHandle | null>(owner, null);
  const [status, setStatus] = useFormState<"pending" | "consumed" | "unavailable" | "unverified">(owner, "pending");
  const [busy, setBusy] = useFormState(owner, false);
  const visible = params.workspaceBookkeeping === "pending" && enabled && Boolean(profile && server && expectedResult);
  useEffect(() => {
    if (!visible || !profile || !server || !expectedResult) return;
    const kind = params.operationKind;
    if ((kind !== "open" && kind !== "create" && kind !== "worktree") || !params.operationReceiptId || !params.operationSourcePath) {
      setStatus("unavailable"); return;
    }
    if (params.operationReceiptVersion !== undefined && params.operationReceiptVersion !== "2") { setStatus("unavailable"); return; }
    void loadConfirmedWorkspaceOperationReceipt(profile, server, { receiptId: params.operationReceiptId, kind, sourcePath: params.operationSourcePath, ...(params.operationReceiptVersion === "2" ? { version: 2 } : {}) }, expectedResult)
      .then((value) => { if (owner.isCurrent()) { setReceipt(value); setStatus(value?.consumed ? "consumed" : value ? "pending" : params.operationReceiptVersion === "2" ? "unverified" : "unavailable"); } })
      .catch(() => { if (owner.isCurrent()) setStatus(params.operationReceiptVersion === "2" ? "unverified" : "unavailable"); });
  }, [owner, visible]);
  const retry = async () => {
    if (!owner.isCurrent() || busy || !profile || !server || !expectedResult) return;
    setBusy(true);
    try {
      const kind = params.operationKind;
      if (kind !== "open" && kind !== "create" && kind !== "worktree") { setStatus("unavailable"); return; }
      if (params.operationReceiptVersion !== undefined && params.operationReceiptVersion !== "2") { setStatus("unavailable"); return; }
      const original = receipt ?? await loadConfirmedWorkspaceOperationReceipt(profile, server, { receiptId: params.operationReceiptId ?? "", kind, sourcePath: params.operationSourcePath ?? "", ...(params.operationReceiptVersion === "2" ? { version: 2 } : {}) }, expectedResult);
      if (!owner.isCurrent()) return;
      if (!original) { setStatus(params.operationReceiptVersion === "2" ? "unverified" : "unavailable"); return; }
      const outcome = await acknowledgeConfirmedWorkspaceOperation(original, { profile, server });
      if (owner.isCurrent()) { setReceipt(original); setStatus(outcome === "superseded" ? "unavailable" : outcome); }
    } catch {
      if (owner.isCurrent()) setStatus(params.operationReceiptVersion === "2" ? "unverified" : "unavailable");
    } finally { setBusy(false); }
  };
  if (!visible || status === "consumed") return null;
  return <View testID="workspace-bookkeeping" style={{ padding: 12 }}>
    <Text style={{ color: colors.textMuted }}>
      {status === "unverified"
        ? t("workspace_bookkeeping.unverified")
        : status === "unavailable"
          ? t("workspace_bookkeeping.unavailable")
          : t("workspace_bookkeeping.ready_retry")}
    </Text>
    <Pressable testID="retry-workspace-bookkeeping" accessibilityRole="button" disabled={busy} onPress={() => void retry()}>
      <Text style={{ color: colors.blue, paddingTop: 8 }}>
        {busy
          ? t("workspace_bookkeeping.retrying")
          : params.operationReceiptVersion === "2"
            ? t("workspace_bookkeeping.verify_original_identity")
            : t("workspace_bookkeeping.retry_local_confirmation")}
      </Text>
    </Pressable>
  </View>;
}

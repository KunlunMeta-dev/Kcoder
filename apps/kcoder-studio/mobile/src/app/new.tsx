import { catalogReadScopeKey, createNewCatalogReadSource } from "@/runtime/task-runtime/new-catalog-read-source";
import { reserveWorkspaceTaskHandoff, loadWorkspaceTaskHandoff, verifyWorkspaceTaskHandoff, confirmWorkspaceOpenDelivery } from "@/storage/pending-workspace-operation-v2";
import { readWorkspaceTaskHandoff, type WorkspaceTaskHandoff } from "@/storage/pending-thread-creation";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { t } from "@/i18n";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { acknowledgeConfirmedWorkspaceOperation, loadConfirmedWorkspaceOperationReceipt, type WorkspaceOperationReceiptHandle } from "@/storage/pending-workspace-operation";
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { WorkspaceOperationBookkeeping } from "@/features/forms/WorkspaceOperationBookkeeping";
import { useFormOwner, useFormState } from "@/features/forms/form-owner";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Dimensions, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Check, ChevronDown, ChevronLeft, FolderGit2, FolderOpen, FolderPlus, Server as ServerIcon, Sparkles, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Field, StatusDot } from "@/components/ui";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { defaultModelOption, modelOptionSelector, selectedModelOption, listModels, listWorkspaceOptions, prepareManagedWorktreeWithReceipt, TaskRuntime, taskRuntimeRegistry, type ModelOption, type WorkspaceOption } from "@/runtime/task-runtime";
import { useApp } from "@/state/AppContext";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import type { TaskCreationClaim } from "@/runtime/task-runtime/types";
import { loadNewWorkspacePreference, saveNewWorkspacePreference, reasoningEffortLabel, type NewWorkspacePreference, type WorkspaceIsolation } from "@/storage/new-workspace-preferences";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { useLocale } from "@/i18n/use-locale";

export default function NewWorkspaceRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ profileId?: string; serverId?: string; cwd?: string; operationReceiptId?: string; operationReceiptVersion?: string; operationKind?: string; operationSourcePath?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [compact, setCompact] = useState(false);
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, markGatewayReauthorizationRequired, demo } = useApp();
  const profileReady = hydrated && (!params.profileId || activeProfile?.id === params.profileId);
  const invalidProfile = hydrated && Boolean(params.profileId) && !profiles.some((profile) => profile.id === params.profileId);
  const [serverId, setSelectedServerId] = useState("");
  const server = useMemo(() => runtime.servers.find((item) => item.id === serverId), [runtime.servers, serverId]);
  const targetScope = activeProfile && server ? threadListScopeKey(activeProfile, server) : null;
  const catalogScope = activeProfile && server ? catalogReadScopeKey(activeProfile, server) : null;
  const currentCatalogScope = useRef(catalogScope);
  currentCatalogScope.current = catalogScope;
  const catalogAuthority = useRef({ profiles, activeProfile, servers: runtime.servers, reauthorizationRequired: runtime.reauthorizationRequired });
  catalogAuthority.current = { profiles, activeProfile, servers: runtime.servers, reauthorizationRequired: runtime.reauthorizationRequired };
  const routeIntentKey = JSON.stringify([params.profileId, params.serverId, params.cwd, params.operationReceiptId, params.operationReceiptVersion, params.operationKind, params.operationSourcePath]);
  const gatewayScope = activeProfile ? [activeProfile.id, activeProfile.baseUrl, activeProfile.authorizationGeneration, activeProfile.deviceId] : null;
  const owner = useFormOwner(JSON.stringify([routeIntentKey, profileReady, gatewayScope, targetScope, catalogScope, demo]));
  const routedIntent = useRef<{ key: string; scope: string } | null>(null);
  if (profileReady && catalogScope && params.serverId === server?.id && params.cwd && (!routedIntent.current || routedIntent.current.key !== routeIntentKey)) {
    routedIntent.current = { key: routeIntentKey, scope: catalogScope };
  }
  const routedCwd = routedIntent.current?.key === routeIntentKey && routedIntent.current.scope === catalogScope
    ? params.cwd?.trim() : undefined;
  const setServerId = (update: SetStateAction<string>) => {
    if (!owner.isCurrent()) return;
    setSelectedServerId((current) => {
      if (!owner.isCurrent()) return current;
      return typeof update === "function" ? update(current) : update;
    });
  };
  const goBack = () => {
    if (owner.isCurrent()) backOrReplace(router, profileHomeHref(params.profileId ?? activeProfile?.id));
  };
  const statusByServerId = useMemo(
    () => new Map(runtime.statuses.map((item) => [item.id, item.status])),
    [runtime.statuses],
  );
  const [cwd, setCwd] = useFormState(owner, "");
  const [workspaceOptions, setWorkspaceOptions] = useFormState<WorkspaceOption[]>(owner, []);
  const [workspacesLoading, setWorkspacesLoading] = useFormState(owner, false);
  const [isolation, setIsolation] = useFormState<WorkspaceIsolation>(owner, "local");
  const [gitRef, setGitRef] = useFormState(owner, "");
  const [model, setModel] = useFormState(owner, "");
  const [models, setModels] = useFormState<ModelOption[]>(owner, []);
  const [modelsLoading, setModelsLoading] = useFormState(owner, false);
  const [reasoningEffort, setReasoningEffort] = useFormState(owner, "");
  const [modelSheet, setModelSheet] = useFormState(owner, false);
  const [prompt, setPrompt] = useFormState(owner, "");
  const [executionMode, setExecutionMode] = useFormState<'default' | 'orchestrate' | 'moa' | 'moa-plan'>(owner, 'default');
  const [loading, setLoading] = useFormState(owner, false);
  const [error, setError] = useFormState<string | null>(owner, null);
  const preferenceScope = activeProfile && server ? JSON.stringify([workspaceStateAuthorizationScope(activeProfile, server), activeProfile.deviceId ?? null]) : null;
  const [preferenceSaveError, setPreferenceSaveError] = useFormState<string | null>(owner, null);
  const [preferenceSaveRevision, setPreferenceSaveRevision] = useFormState(owner, 0);
  const [preferenceReadError, setPreferenceReadError] = useFormState<string | null>(owner, null);
  const [preferenceReadRevision, setPreferenceReadRevision] = useFormState(owner, 0);
  const [preferenceReadSuccess, setPreferenceReadSuccess] = useFormState(owner, false);
  const [preferenceApplied, setPreferenceApplied] = useFormState(owner, false);
  const [restoredPreference, setRestoredPreference] = useFormState<NewWorkspacePreference | null>(owner, null);
  const selectionIntentRef = useRef<{ owner: typeof owner; revision: number } | null>(null);
  if (selectionIntentRef.current?.owner !== owner) selectionIntentRef.current = { owner, revision: 0 };
  const selectionIntent = selectionIntentRef.current;
  const preferenceSaveIntentRef = useRef<{ owner: typeof owner; revision: number } | null>(null);
  if (preferenceSaveIntentRef.current?.owner !== owner) preferenceSaveIntentRef.current = { owner, revision: 0 };
  const preferenceSaveIntent = preferenceSaveIntentRef.current;
  const editCwd = (value: string) => { if (owner.isCurrent()) { selectionIntent.revision++; setCwd(value); } };
  const editIsolation = (value: WorkspaceIsolation) => { if (owner.isCurrent()) { selectionIntent.revision++; setIsolation(value); } };
  const [workspacesReady, setWorkspacesReady] = useFormState(owner, false);
  const [modelsReady, setModelsReady] = useFormState(owner, false);
  const [catalogRevision, setCatalogRevision] = useFormState(owner, 0);
  const catalogsReady = workspacesReady && modelsReady;
  const retryCatalogs = () => {
    if (!owner.isCurrent()) return;
    setWorkspacesReady(false);
    setModelsReady(false);
    setError(null);
    setCatalogRevision((value) => value + 1);
  };
  const serverSignature = runtime.servers.map((item) => item.id).join("\0");
  const closeModelSheet = () => setModelSheet(false);
  const modelSheetRef = useModalFocusTrap(modelSheet, closeModelSheet);

  useEffect(() => {
    const update = ({ window }: { window: { height: number } }) => setCompact(window.height < 700);
    update({ window: Dimensions.get("window") });
    const subscription = Dimensions.addEventListener("change", update);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (owner.isCurrent() && shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: params.profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(params.profileId!);
    }
  }, [activeProfile?.id, hydrated, isFocused, params.profileId, profiles, setActiveProfile]);

  useEffect(() => {
    if (!owner.isCurrent()) return;
    setServerId("");
    setCwd("");
    setWorkspaceOptions([]);
    setIsolation("local");
    setGitRef("");
    setModels([]);
    setModel("");
    setReasoningEffort("");
    setModelSheet(false);
    setError(null);
  }, [params.profileId]);

  useEffect(() => {
    if (!owner.isCurrent() || !profileReady || runtime.loading) return;
    setServerId((current) => {
      if (current && runtime.servers.some((item) => item.id === current)) return current;
      return (runtime.servers.find((item) => item.id === params.serverId) ?? runtime.servers[0])?.id ?? "";
    });
  }, [activeProfile?.id, params.serverId, profileReady, runtime.loading, serverSignature]);

  useEffect(() => {
    if (!profileReady || !activeProfile || !server || !catalogScope) return;
    const controller = new AbortController();
    const source = demo ? undefined : createNewCatalogReadSource(activeProfile, server, () => {
      const authority = catalogAuthority.current;
      // The directory belongs to the active profile, not to the selected server. Switching
      // selected servers only aborts this page's waiters; a lawful foreign waiter can finish.
      if (authority.activeProfile?.id !== activeProfile.id || authority.reauthorizationRequired) return false;
      const originalProfiles = authority.profiles.filter(value => value.id === activeProfile.id);
      const originalServers = authority.servers.filter(value => value.id === server.id);
      return originalProfiles.length === 1 && originalServers.length === 1 &&
        catalogReadScopeKey(originalProfiles[0], originalServers[0]) === catalogScope &&
        catalogReadScopeKey(authority.activeProfile, originalServers[0]) === catalogScope;
    });
    const current = () => !controller.signal.aborted && owner.isCurrent() && currentCatalogScope.current === catalogScope;
    setWorkspaceOptions([]);
    setWorkspacesLoading(true);
    setWorkspacesReady(false);
    setModels([]);
    setModel("");
    setReasoningEffort("");
    setModelsLoading(true);
    setModelsReady(false);
    // Both fixed candidates are registered synchronously. Only the real cache loaders acquire a client.
    const optionsPromise = source
      ? source.run("workspace", () => listWorkspaceOptions(activeProfile, server, { signal: controller.signal }, source))
      : Promise.resolve<WorkspaceOption[]>([{ path: server.workspacePath ?? "/data/projects/kcoder", label: "KCoder", kind: "workspace" }]);
    const modelsPromise = source
      ? source.run("models", () => listModels(activeProfile, server, { signal: controller.signal, source }))
      : Promise.resolve<ModelOption[]>([
        { id: "demo::MiniMax-M3", model: "MiniMax-M3", displayName: "MiniMax-M3", providerId: "kunlunmeta", providerName: "KCoder Meta", isDefault: true },
        { id: "demo::kimi-for-coding", model: "kimi-for-coding", displayName: "Kimi for Coding", providerId: "kimi", providerName: "Kimi" },
      ]);
    void optionsPromise.then(options => {
      if (!current()) return;
      setWorkspaceOptions(options);
      if (selectionIntent.revision === 0 && !preferenceApplied) {
        setCwd(routedCwd || server.workspacePath || options[0]?.path || "/");
        setIsolation("local");
      }
      setWorkspacesReady(true);
    }).catch(value => {
      if (!current()) return;
      if (selectionIntent.revision === 0 && !preferenceApplied) setCwd(routedCwd || server.workspacePath || "/");
      setError(value instanceof Error ? value.message : String(value));
    }).finally(() => { if (current()) setWorkspacesLoading(false); });
    void modelsPromise.then(values => {
      if (!current()) return;
      setModels(values);
      const selected = defaultModelOption(values);
      setModel(demo ? "MiniMax-M3" : selected ? modelOptionSelector(selected) : "");
      setReasoningEffort(demo ? "medium" : selected?.defaultReasoningEffort ?? "");
      setModelsReady(true);
    }).catch(value => { if (current()) setError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (current()) setModelsLoading(false); });
    // Abort this page's waiters. Other authorized waiters retain their cache controller's loader.
    return () => controller.abort();
  }, [owner, demo, profileReady, catalogRevision]);

  useEffect(() => {
    if (demo || !profileReady || !activeProfile || !server || !preferenceScope) return;
    let cancelled = false;
    setPreferenceReadSuccess(false);
    setPreferenceApplied(false);
    setPreferenceReadError(null);
    // Legacy keys have no owner; only this full authorization/device scope is read.
    void loadNewWorkspacePreference(activeProfile.id, server.id, preferenceScope)
      .then((value) => {
        if (cancelled || !owner.isCurrent()) return;
        setRestoredPreference(value);
        setPreferenceReadSuccess(true);
      })
      .catch(() => { if (!cancelled && owner.isCurrent()) setPreferenceReadError(t("new.preference_read_error")); });
    return () => { cancelled = true; };
  }, [owner, demo, profileReady, preferenceScope, preferenceReadRevision]);

  useEffect(() => {
    if (!owner.isCurrent() || !workspacesReady || !preferenceReadSuccess || preferenceApplied) return;
    if (selectionIntent.revision === 0 && !routedCwd && restoredPreference) {
      setCwd(restoredPreference.cwd);
      setIsolation(workspaceOptions.find((option) => option.path === restoredPreference.cwd)?.kind === "worktree" ? "local" : restoredPreference.isolation);
    }
    // Saving starts on the next render, after the restored selection has been committed.
    setPreferenceApplied(true);
  }, [owner, workspacesReady, preferenceReadSuccess, preferenceApplied, restoredPreference, routedCwd, workspaceOptions]);

  useEffect(() => {
    if (demo || !owner.isCurrent() || !profileReady || !activeProfile || !server || !preferenceScope || !workspacesReady || !cwd.trim()) return;
    if (!preferenceApplied && selectionIntent.revision === 0 && !routedCwd) return;
    const revision = ++preferenceSaveIntent.revision;
    setPreferenceSaveError(null);
    // Ordered at the captured key; only the latest same-owner result changes the form.
    void saveNewWorkspacePreference(activeProfile.id, server.id, preferenceScope, { cwd: cwd.trim(), isolation })
      .then(() => { if (owner.isCurrent() && preferenceSaveIntent.revision === revision) setPreferenceSaveError(null); })
      .catch(() => { if (owner.isCurrent() && preferenceSaveIntent.revision === revision) setPreferenceSaveError(t("new.preference_save_error")); });
  }, [owner, demo, profileReady, preferenceScope, workspacesReady, preferenceApplied, selectionIntent.revision, cwd, isolation, preferenceSaveRevision]);


  const selectServer = (nextServerId: string) => {
    if (!owner.isCurrent() || nextServerId === serverId) return;
    const next = runtime.servers.find((item) => item.id === nextServerId);
    setServerId(nextServerId);
    setExecutionMode('default');
    setCwd(next?.workspacePath ?? "/");
    setWorkspaceOptions([]);
    setIsolation("local");
    setGitRef("");
    setModels([]);
    setModel("");
    setReasoningEffort("");
    setModelsLoading(true);
    setModelSheet(false);
  };

  const [creationStage, setCreationStage] = useFormState<string | null>(owner, null);
  const [pendingCreated, setPendingCreated] = useFormState<{ task: TaskRuntime; receipt: WorkspaceOperationReceiptHandle; profile: GatewayProfile; server: KCoderServer; params: Record<string, string>; handoff?: WorkspaceTaskHandoff } | null>(owner, null);
  const [pendingHandoff, setPendingHandoff] = useFormState<WorkspaceTaskHandoff | null>(owner, null);
  const [handoffChecking, setHandoffChecking] = useFormState(owner, !demo);
  const [handoffError, setHandoffError] = useFormState<string | null>(owner, null);
  const [handoffRevision, setHandoffRevision] = useFormState(owner, 0);
  const createdContinuation = useRef<{ owner: typeof owner; value: NonNullable<typeof pendingCreated>; busy: boolean; navigated: boolean } | null>(null);
  if (createdContinuation.current?.owner !== owner) createdContinuation.current = null;
  const continueCreated = async (entry: NonNullable<typeof createdContinuation.current>) => {
    if (!owner.isCurrent() || entry.owner !== owner || entry.busy || entry.navigated) return;
    entry.busy = true; setLoading(true);
    try {
      const outcome = await acknowledgeConfirmedWorkspaceOperation(entry.value.receipt, { profile: entry.value.profile, server: entry.value.server });
      if (!owner.isCurrent() || createdContinuation.current !== entry) return;
      if (outcome === "unverified" || outcome === "superseded") {
        setError(t("new.created_identity_unverified")); return;
      }
      entry.navigated = true;
      setPendingCreated(null);
      router.replace({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { ...entry.value.params,
        operationReceiptId: entry.value.receipt.id, operationReceiptVersion: "2", operationKind: entry.value.params.operationKind ?? "worktree", operationSourcePath: entry.value.params.operationSourcePath,
        ...(entry.value.handoff ? { creationRequestId: entry.value.handoff.clientRequestId } : {}),
        ...(outcome !== "consumed" ? { workspaceBookkeeping: "pending" } : {}) } });
    } finally { entry.busy = false; setLoading(false); }
  };

  const findOriginalHandoff = async (sourceCwd: string, isCurrent: () => boolean) => {
    if (!activeProfile || !server || !isCurrent()) return null;
    const routedReceipt = params.operationReceiptVersion === "2" && params.operationReceiptId
      && sourceCwd === routedCwd && params.operationSourcePath
      && ["open", "create", "worktree"].includes(params.operationKind ?? "")
      ? await loadConfirmedWorkspaceOperationReceipt(activeProfile, server, {
        version: 2, receiptId: params.operationReceiptId,
        kind: params.operationKind as "open" | "create" | "worktree",
        sourcePath: params.operationSourcePath,
      }, sourceCwd) : undefined;
    if (!isCurrent()) return null;
    if (routedReceipt !== undefined) {
      if (!routedReceipt) throw new Error(t("new.original_open_identity_unverified"));
      await confirmWorkspaceOpenDelivery(activeProfile, server, routedReceipt, isCurrent);
      if (!isCurrent()) return null;
      const exact = await loadWorkspaceTaskHandoff(activeProfile, server, { receiptId: routedReceipt.id });
      if (!isCurrent()) return null;
      if (exact) return exact;
      // Open and worktree preparation have distinct durable receipt IDs. The
      // verified source open locator must not hide the later worktree handoff.
      // Discover it from the verified source, independently of delayed prefs.
      const linked = await loadWorkspaceTaskHandoff(activeProfile, server, {
        kind: "worktree", sourcePath: params.operationKind === "worktree"
          ? params.operationSourcePath! : routedReceipt.result,
      });
      if (!isCurrent()) return null;
      if (linked) await verifyWorkspaceTaskHandoff(activeProfile, server, linked.handle);
      return isCurrent() ? linked : null;
    }
    const exactCwd = await loadWorkspaceTaskHandoff(activeProfile, server, { cwd: sourceCwd });
    if (!isCurrent()) return null;
    const worktree = await loadWorkspaceTaskHandoff(activeProfile, server, { kind: "worktree", sourcePath: sourceCwd });
    if (!isCurrent()) return null;
    if (exactCwd && worktree && (exactCwd.handle.key !== worktree.handle.key
      || exactCwd.handle.clientRequestId !== worktree.handle.clientRequestId
      || exactCwd.handle.receiptId !== worktree.handle.receiptId)) {
      throw new Error(t("new.multiple_original_task_handoffs"));
    }
    const linked = exactCwd ?? worktree;
    if (linked) await verifyWorkspaceTaskHandoff(activeProfile, server, linked.handle);
    return isCurrent() ? linked : null;
  };

  useEffect(() => {
    if (demo || !owner.isCurrent() || !profileReady || !activeProfile || !server || !cwd.trim()) return;
    let cancelled = false; setHandoffChecking(true); setHandoffError(null);
    const current = () => !cancelled && owner.isCurrent();
    void findOriginalHandoff(cwd.trim(), current)
      .then(found => { if (current()) setPendingHandoff(found?.handle ?? null); })
      .catch(value => { if (current()) setHandoffError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (current()) setHandoffChecking(false); });
    return () => { cancelled = true; };
  }, [owner, profileReady, server, demo, cwd, routedCwd, handoffRevision]);

  const retainCreated = async (task: TaskRuntime, receipt: WorkspaceOperationReceiptHandle, handoff: WorkspaceTaskHandoff | undefined, sourcePath: string, taskCwd: string) => {
    if (!owner.isCurrent() || !activeProfile || !server) return;
    const original = handoff ? await readWorkspaceTaskHandoff(handoff) : undefined;
    if (!owner.isCurrent()) return;
    const value = { task, receipt, handoff, profile: { ...activeProfile }, server: { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) },
      params: { profileId: activeProfile.id, serverId: server.id, threadId: task.getSnapshot().threadId, cwd: taskCwd, title: task.getSnapshot().title, operationSourcePath: sourcePath, operationKind: original?.linked?.kind ?? "worktree" } };
    const entry = { owner, value, busy: false, navigated: false };
    // The producer already persisted the thread identity. Publish continuation before optional prefs await.
    createdContinuation.current = entry; setPendingCreated(value); if (handoff) setPendingHandoff(handoff);
    await saveWorkspaceState(activeProfile.id, server.id, task.getSnapshot().threadId, { activeTab: "agent", model: original?.linked?.input.model ?? (model.trim() || undefined), reasoningEffort: original?.linked?.input.reasoningEffort ?? (reasoningEffort || undefined) }, workspaceStateAuthorizationScope(activeProfile, server), captureWorkspaceProfileIdentity(activeProfile)).catch(() => {});
    if (owner.isCurrent()) await continueCreated(entry);
  };
  const recoverOriginal = async () => {
    if (!owner.isCurrent() || loading || !pendingHandoff || !activeProfile || !server) return;
    setLoading(true); setError(null);
    let claim: TaskCreationClaim | undefined; let unregister: (() => void) | undefined;
    try {
      const pending = await verifyWorkspaceTaskHandoff(activeProfile, server, pendingHandoff);
      if (!owner.isCurrent()) return;
      const cached = pending.threadId ? taskRuntimeRegistry.get(activeProfile.id, server.id, pending.threadId) : undefined;
      if (cached && !cached.isDisposed() && cached.reconnectContext && cached.reconnectContext.profile.deviceId === activeProfile.deviceId && threadListScopeKey(cached.reconnectContext.profile, cached.reconnectContext.server) === threadListScopeKey(activeProfile, server)) {
        if (!["prepared","not-sent"].includes(pending.linked!.turn.phase)) {
          await retainCreated(cached, pending.linked!.receipt, pendingHandoff, pending.linked!.sourcePath, pending.linked!.input.cwd); return;
        }
        // Release the original connection before resuming the same idle thread and its definitely-unsent turn.
        cached.close();
      }
      const authorizationScope = profileAuthorizationScopeKey(activeProfile);
      claim = TaskRuntime.claimCreation({ ...pending.linked!.input, profile: activeProfile, server, workspaceHandoff: pendingHandoff, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, authorizationScope) }, taskRuntimeRegistry);
      const captured = claim; unregister = owner.onDispose(() => captured.release());
      const task = await claim.result;
      if (!owner.isCurrent()) return;
      if (!claim.adopt(taskRuntimeRegistry, activeProfile.id, server.id)) throw new Error(t("new.original_task_connection_released"));
      await retainCreated(task, pending.linked!.receipt, pendingHandoff, pending.linked!.sourcePath, pending.linked!.input.cwd);
    } catch (value) { if (owner.isCurrent()) setError(value instanceof Error ? value.message : String(value)); }
    finally { unregister?.(); claim?.release(); setLoading(false); }
  };

  const create = async () => {
    if (!owner.isCurrent() || createdContinuation.current?.owner === owner || pendingHandoff || handoffChecking || handoffError || loading || !catalogsReady || !profileReady || runtime.loading || modelsLoading || workspacesLoading || !activeProfile || !server || !prompt.trim() || !cwd.trim()) return;
    const capturedWorkspaceIdentity = captureWorkspaceProfileIdentity(activeProfile);
    selectionIntent.revision++;
    setLoading(true);
    setCreationStage(t("new.preparing_task"));
    setError(null);
    let claim: TaskCreationClaim | undefined;
    let unregisterClaim: (() => void) | undefined;
    try {
      const sourceCwd = cwd.trim();
      if (!demo) {
        const original = await findOriginalHandoff(sourceCwd, () => owner.isCurrent());
        if (!owner.isCurrent()) return;
        if (original) { setPendingHandoff(original.handle); setError(t("new.original_task_handoff_incomplete")); return; }
      }
      let workspaceReceipt: WorkspaceOperationReceiptHandle | undefined;
      const taskCwd = isolation === "worktree"
        ? demo
          ? `${sourceCwd.replace(/\/$/, "")}/.kcoder/worktrees/mobile-demo`
          : await prepareManagedWorktreeWithReceipt(activeProfile, server, sourceCwd, gitRef, (stage) => setCreationStage(stage === "opening" ? t("new.stage_registering_project") : stage === "preparing" ? t("new.stage_creating_worktree") : stage === "checking" ? t("new.stage_verifying_creation") : t("new.stage_workspace_ready"))).then((result) => { workspaceReceipt = result.receipt; return result.path; })
        : sourceCwd;
      if (!owner.isCurrent()) return;
      if (!workspaceReceipt && params.operationReceiptVersion === "2" && params.operationReceiptId && routedCwd === taskCwd && params.operationSourcePath && ["open","create","worktree"].includes(params.operationKind ?? "")) {
        workspaceReceipt = await loadConfirmedWorkspaceOperationReceipt(activeProfile, server, { version: 2, receiptId: params.operationReceiptId, kind: params.operationKind as "open" | "create" | "worktree", sourcePath: params.operationSourcePath }, taskCwd) ?? undefined;
        if (!workspaceReceipt) throw new Error(t("new.original_open_identity_unverified"));
      }
      const creationInput = { cwd: taskCwd, prompt: prompt.trim(), sessionMode: executionMode === 'orchestrate' ? 'orchestrate' as const : undefined, turnMode: executionMode === 'moa' || executionMode === 'moa-plan' ? executionMode : undefined, model: model.trim() || undefined, reasoningEffort: reasoningEffort || undefined, managedWorktreeSourcePath: isolation === "worktree" || params.operationKind === "worktree" && routedCwd === taskCwd ? server.workspacePath : undefined };
      const handoff = workspaceReceipt?.version === 2 ? await reserveWorkspaceTaskHandoff(activeProfile, server, workspaceReceipt, creationInput) : undefined;
      if (handoff) setPendingHandoff(handoff);
      if (!owner.isCurrent()) return;
      const capturedAuthorizationScope = profileAuthorizationScopeKey(activeProfile);
      const task = demo ? TaskRuntime.demo(`demo-created-${Date.now()}`) : await (() => {
        claim = TaskRuntime.claimCreation({ ...creationInput, workspaceHandoff: handoff, profile: activeProfile, server, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope) }, taskRuntimeRegistry);
        const captured = claim;
        unregisterClaim = owner.onDispose(() => captured.release());
        return claim.result;
      })();
      if (!owner.isCurrent()) { if (demo) task.close(); return; }
      if (claim) {
        if (!claim.adopt(taskRuntimeRegistry, activeProfile.id, server.id)) throw new Error(t("new.task_creation_result_released"));
      } else taskRuntimeRegistry.put(activeProfile.id, server.id, task);
      if (workspaceReceipt?.version === 2) {
        await retainCreated(task, workspaceReceipt, handoff, params.operationReceiptVersion === "2" && params.operationReceiptId === workspaceReceipt.id ? params.operationSourcePath! : sourceCwd, taskCwd);
      } else {
        const bookkeeping = workspaceReceipt ? await acknowledgeConfirmedWorkspaceOperation(workspaceReceipt) : "consumed";
        if (!owner.isCurrent()) return;
        router.replace({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: task.getSnapshot().threadId, cwd: taskCwd, title: task.getSnapshot().title, ...(workspaceReceipt && bookkeeping !== "consumed" ? { workspaceBookkeeping: "pending", operationReceiptId: workspaceReceipt.id, operationKind: "worktree", operationSourcePath: sourceCwd } : {}) } });
      }
    } catch (value) {
      if (owner.isCurrent()) setError(value instanceof Error ? value.message : String(value));
    } finally {
      unregisterClaim?.();
      claim?.release();
      setLoading(false);
    }
  };

  if (invalidProfile) {
    return <View style={[styles.root, { paddingTop: insets.top }]}><View style={styles.header}><Pressable accessibilityLabel={t("task.back")} onPress={goBack} style={styles.back}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{t("task.new_task")}</Text><View style={styles.headerSpacer} /></View><EmptyState icon={<ServerIcon size={42} color={colors.textDim} />} title={t("home.deleted_gateway_title")} body={t("new.removed_gateway_body")} /></View>;
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
      <View style={styles.header}><Pressable accessibilityLabel={t("task.back")} onPress={goBack} style={styles.back}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{t("task.new_task")}</Text><View style={styles.headerSpacer} /></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}> 
        <WorkspaceOperationBookkeeping profile={activeProfile} server={server} expectedResult={routedCwd} enabled={profileReady && !runtime.loading} />
        <View style={[styles.hero, compact && styles.heroCompact]}><View style={[styles.heroIcon, compact && styles.heroIconCompact]}><Sparkles size={compact ? 18 : 24} color={colors.text} /></View><View style={compact && styles.heroCompactCopy}><Text style={[styles.title, compact && styles.titleCompact]}>{t("new.hero_title")}</Text>{!compact ? <Text style={styles.subtitle}>{t("new.hero_subtitle")}</Text> : null}</View></View>
        {!profileReady || runtime.loading ? <View style={styles.profileLoading}><ActivityIndicator color={colors.textMuted} /><Text style={styles.profileLoadingText}>{t("new.switching_gateway")}</Text></View> : null}
        <View style={styles.section}><Text style={styles.sectionTitle}>{t("task.servers")}</Text>{runtime.servers.map((item) => {
          const status = statusByServerId.get(item.id) ?? "checking";
          const statusLabel = status === "online" ? t("settings.status_online") : status === "offline" ? t("task.offline") : t("settings.status_checking");
          return <Pressable key={item.id} testID={`server-option-${item.id}`} disabled={!profileReady || runtime.loading} onPress={() => selectServer(item.id)} style={[styles.serverOption, serverId === item.id && styles.serverSelected]}><ServerIcon size={19} color={serverId === item.id ? colors.blue : colors.textMuted} /><View style={styles.serverCopy}><Text style={styles.serverLabel}>{item.label}</Text><Text style={styles.serverPath} numberOfLines={1}>{item.workspacePath ?? item.description}</Text></View><View style={{ alignItems: "center", gap: 3 }}><StatusDot status={status} /><Text style={{ color: status === "offline" ? colors.textDim : colors.textMuted, fontSize: 9 }}>{statusLabel}</Text></View>{serverId === item.id ? <Check size={18} color={colors.blue} /> : null}</Pressable>;
        })}</View>
        <View style={styles.section}>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>{t("new.projects")}</Text>{workspacesLoading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Pressable accessibilityLabel={t("task.add_project")} onPress={() => { if (owner.isCurrent()) router.push({ pathname: "/open-project", params: { profileId: activeProfile?.id } }); }} style={styles.addProject}><FolderPlus size={16} color={colors.textMuted} /><Text style={styles.addProjectText}>{t("new.add")}</Text></Pressable>}</View>
          {workspaceOptions.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projectOptions}>{workspaceOptions.map((item) => <Pressable key={`${item.kind}:${item.path}`} testID={`workspace-option-${encodeURIComponent(item.path)}`} onPress={() => { editCwd(item.path); editIsolation(item.kind === "worktree" ? "local" : isolation); }} style={[styles.projectOption, cwd === item.path && styles.projectSelected]}>{item.kind === "worktree" ? <FolderGit2 size={19} color={colors.blue} /> : <FolderOpen size={19} color={colors.textMuted} />}<View style={styles.projectCopy}><Text numberOfLines={1} style={styles.projectName}>{item.label}</Text><Text numberOfLines={1} style={styles.projectPath}>{item.path}</Text></View>{cwd === item.path ? <Check size={17} color={colors.green} /> : null}</Pressable>)}</ScrollView> : !workspacesLoading ? <Text style={styles.emptyProjects}>{t("new.empty_projects")}</Text> : null}
          <Field testID="workspace-path" label={t("new.workspace_directory")} value={cwd} onChangeText={(value) => { editCwd(value); editIsolation("local"); }} editable={profileReady && !runtime.loading && !workspacesLoading} autoCapitalize="none" autoCorrect={false} placeholder="/path/to/project" />
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("new.isolation_method")}</Text>
          <View style={styles.isolationOptions}>
            <Pressable testID="workspace-isolation-local" onPress={() => editIsolation("local")} style={[styles.isolationOption, isolation === "local" && styles.isolationSelected]}><FolderOpen size={18} color={isolation === "local" ? colors.green : colors.textMuted} /><View style={styles.isolationCopy}><Text style={styles.isolationTitle}>{t("new.current_workspace")}</Text><Text style={styles.isolationBody}>{t("new.current_workspace_description")}</Text></View></Pressable>
            <Pressable testID="workspace-isolation-worktree" disabled={workspaceOptions.find((item) => item.path === cwd)?.kind === "worktree"} onPress={() => editIsolation("worktree")} style={[styles.isolationOption, isolation === "worktree" && styles.isolationSelected, workspaceOptions.find((item) => item.path === cwd)?.kind === "worktree" && styles.optionDisabled]}><FolderGit2 size={18} color={isolation === "worktree" ? colors.green : colors.textMuted} /><View style={styles.isolationCopy}><Text style={styles.isolationTitle}>{t("new.worktree")}</Text><Text style={styles.isolationBody}>{t("new.worktree_description")}</Text></View></Pressable>
          </View>
          {isolation === "worktree" ? <Field testID="workspace-git-ref" label={t("new.git_ref_optional")} value={gitRef} onChangeText={setGitRef} autoCapitalize="none" autoCorrect={false} placeholder={t("new.git_ref_placeholder")} /> : null}
        </View>
        <View style={styles.modelField}>
          <Text style={styles.fieldLabel}>{t("new.model")}</Text>
          <Pressable testID="model-selector" disabled={!profileReady || runtime.loading || modelsLoading || !server} onPress={() => setModelSheet(true)} style={styles.modelSelector}>
            <View style={styles.modelCopy}>
              <Text style={styles.modelName}>{selectedModelOption(models, model)?.displayName ?? (model.split("::").at(-1) || t("task.server_default_model"))}</Text>
              <Text style={styles.modelProvider}>{selectedModelOption(models, model)?.providerName ?? "KCoder"}</Text>
            </View>
            {modelsLoading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <ChevronDown size={18} color={colors.textMuted} />}
          </Pressable>
        </View>
        {(selectedModelOption(models, model)?.supportedReasoningEfforts?.length ?? 0) > 0 ? <View style={styles.reasoning}><Text style={styles.fieldLabel}>{t("task.reasoning_effort")}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reasoningOptions}>{selectedModelOption(models, model)?.supportedReasoningEfforts?.map((effort) => <Pressable key={effort} accessibilityRole="radio" aria-checked={reasoningEffort === effort} accessibilityState={{ checked: reasoningEffort === effort, disabled: !profileReady || runtime.loading || modelsLoading }} disabled={!profileReady || runtime.loading || modelsLoading} onPress={() => setReasoningEffort(effort)} style={[styles.reasoningOption, { minHeight: 44 }, reasoningEffort === effort && styles.reasoningSelected]}><Text style={[styles.reasoningText, reasoningEffort === effort && styles.reasoningSelectedText]}>{reasoningEffortLabel(effort)}</Text></Pressable>)}</ScrollView></View> : null}
      </ScrollView>
      <View style={[styles.composerDock, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {preferenceReadError ? <View><Text testID="new-workspace-preference-read-error" style={styles.error}>{preferenceReadError}</Text><Button testID="retry-new-workspace-preference-read" variant="secondary" onPress={() => { if (owner.isCurrent()) setPreferenceReadRevision((value) => value + 1); }}>{t("new.retry_read_preferences")}</Button></View> : null}
        {preferenceSaveError ? <View><Text testID="new-workspace-preference-error" style={styles.error}>{preferenceSaveError}</Text><Button testID="retry-new-workspace-preference" variant="secondary" onPress={() => { if (owner.isCurrent()) setPreferenceSaveRevision((value) => value + 1); }}>{t("new.retry_save_preferences")}</Button></View> : null}
        {error ? <Text testID="new-workspace-error" style={styles.error}>{error}</Text> : null}
        {!catalogsReady && error ? <Button testID="retry-new-workspace-catalogs" variant="secondary" onPress={retryCatalogs}>{t("new.retry_catalogs")}</Button> : null}
        {handoffError ? <View><Text testID="workspace-task-handoff-error" style={styles.fieldLabel}>{handoffError}</Text><Button testID="retry-task-handoff-lookup" variant="secondary" disabled={handoffChecking || loading} onPress={() => setHandoffRevision(value => value + 1)}>{t("new.verify_original_task_handoff")}</Button></View> : null}
        {pendingHandoff && !pendingCreated ? <Button testID="recover-created-workspace-task" variant="secondary" disabled={loading || handoffChecking} onPress={() => void recoverOriginal()}>{t("new.restore_original_task")}</Button> : null}
        {pendingCreated ? <Button testID="retry-created-workspace-scope" variant="secondary" disabled={loading} onPress={() => { const entry = createdContinuation.current; if (entry) void continueCreated(entry); }}>{t("new.continue_created_task")}</Button> : null}
        {loading && creationStage ? <Text testID="workspace-operation-stage" style={styles.fieldLabel}>{creationStage}</Text> : null}
        <Text style={styles.fieldLabel}>{t("new.task_label")}</Text>
          <ScrollView horizontal contentContainerStyle={styles.reasoningOptions} showsHorizontalScrollIndicator={false}>
            {(['default', 'orchestrate', 'moa', 'moa-plan'] as const).map(mode => (
              <Button key={mode} testID={`new-execution-mode-${mode}`} variant={executionMode === mode ? 'primary' : 'secondary'} disabled={loading} onPress={() => setExecutionMode(mode)}>{mode === 'default' ? t("new.standard_mode") : `/${mode}`}</Button>
            ))}
          </ScrollView>
        <View style={styles.promptRow}>
          <TextInput testID="new-workspace-prompt" value={prompt} onChangeText={setPrompt} multiline placeholder={t("new.prompt_placeholder")} placeholderTextColor={colors.textDim} style={styles.promptInput} />
          <Button testID="create-workspace" style={styles.createButton} variant="primary" loading={loading} disabled={Boolean(pendingCreated || pendingHandoff || handoffError) || handoffChecking || loading || !catalogsReady || !profileReady || runtime.loading || modelsLoading || workspacesLoading || !server || !prompt.trim() || !cwd.trim()} onPress={() => void create()}>{isolation === "worktree" ? t("new.create_worktree_action") : t("new.create_action")}</Button>
        </View>
      </View>
      <Modal visible={modelSheet} transparent animationType="slide" onRequestClose={closeModelSheet}>
        <Pressable style={styles.sheetOverlay} onPress={closeModelSheet} />
        <View ref={modelSheetRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.sheetHeader}><View><Text style={styles.sheetTitle}>{t("new.choose_model")}</Text><Text style={styles.sheetSubtitle}>{server?.label}</Text></View><Pressable accessibilityLabel={t("common.close")} onPress={() => setModelSheet(false)} style={styles.close}><X size={20} color={colors.textMuted} /></Pressable></View>
          <ScrollView style={styles.modelList}>
            {models.map((item) => (
              <Pressable key={item.id} onPress={() => { setModel(modelOptionSelector(item)); setReasoningEffort(item.defaultReasoningEffort ?? ""); setModelSheet(false); }} style={styles.modelOption}>
                <View style={styles.modelCopy}><Text style={styles.modelOptionName}>{item.displayName}</Text><Text style={styles.modelProvider}>{item.providerName}{item.supportsVision ? t("task.supports_images") : ""}</Text></View>
                {selectedModelOption(models, model)?.id === item.id ? <Check size={19} color={colors.green} /> : null}
              </Pressable>
            ))}
            {models.length === 0 && !modelsLoading ? <Text style={styles.noModels}>{t("new.no_models")}</Text> : null}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ root: { flex: 1, backgroundColor: colors.background }, header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm }, back: { width: 46, height: 46, alignItems: "center", justifyContent: "center" }, headerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700", textAlign: "center" }, headerSpacer: { width: 46 }, content: { padding: spacing.lg, gap: spacing.lg, maxWidth: 680, width: "100%", alignSelf: "center" }, hero: { alignItems: "center", paddingVertical: spacing.lg, gap: spacing.sm }, heroCompact: { flexDirection: "row", justifyContent: "center", paddingVertical: spacing.xs }, heroCompactCopy: { justifyContent: "center" }, heroIcon: { width: 52, height: 52, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }, heroIconCompact: { width: 36, height: 36, borderRadius: radius.md }, title: { color: colors.text, fontSize: 21, fontWeight: "700" }, titleCompact: { fontSize: 17 }, subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, textAlign: "center" }, profileLoading: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface }, profileLoadingText: { color: colors.textMuted, fontSize: 13 }, section: { gap: spacing.sm }, sectionHeader: { minHeight: 30, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, sectionTitle: { color: colors.text, fontSize: 13, fontWeight: "600" }, addProject: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: spacing.sm, borderRadius: radius.sm }, addProjectText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, projectOptions: { gap: spacing.sm, paddingRight: spacing.sm }, projectOption: { width: 248, minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surface }, projectSelected: { borderColor: colors.green, backgroundColor: colors.surfaceHover }, projectCopy: { flex: 1 }, projectName: { color: colors.text, fontSize: 13, fontWeight: "700" }, projectPath: { color: colors.textDim, fontSize: 10, marginTop: 4 }, emptyProjects: { color: colors.textDim, fontSize: 12, lineHeight: 18 }, isolationOptions: { flexDirection: "row", gap: spacing.sm }, isolationOption: { flex: 1, minHeight: 70, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surface }, isolationSelected: { borderColor: colors.green, backgroundColor: colors.surfaceHover }, isolationCopy: { flex: 1 }, isolationTitle: { color: colors.text, fontSize: 12, fontWeight: "700" }, isolationBody: { color: colors.textDim, fontSize: 10, lineHeight: 14, marginTop: 4 }, optionDisabled: { opacity: 0.4 }, serverOption: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surface }, serverSelected: { borderColor: colors.blue, backgroundColor: colors.surfaceHover }, serverCopy: { flex: 1 }, serverLabel: { color: colors.text, fontSize: 14, fontWeight: "600" }, serverPath: { color: colors.textDim, fontSize: 11, marginTop: 4 }, modelField: { gap: spacing.sm }, fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600" }, modelSelector: { minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surface }, modelCopy: { flex: 1 }, modelName: { color: colors.text, fontSize: 14, fontWeight: "600" }, modelProvider: { color: colors.textDim, fontSize: 11, marginTop: 3 }, reasoning: { gap: spacing.sm }, reasoningOptions: { gap: spacing.sm, paddingRight: spacing.sm }, reasoningOption: { minWidth: 72, height: 38, paddingHorizontal: spacing.md, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surface }, reasoningSelected: { borderColor: colors.green, backgroundColor: colors.surfaceHover }, reasoningText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, reasoningSelectedText: { color: colors.green }, composerDock: { width: "100%", maxWidth: 680, alignSelf: "center", gap: 6, paddingHorizontal: spacing.md, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceRaised }, promptRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }, promptInput: { flex: 1, minHeight: 48, maxHeight: 92, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, color: colors.text, backgroundColor: colors.background, textAlignVertical: "top" }, createButton: { minWidth: 92 }, error: { color: colors.red, fontSize: 13 }, sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay }, sheet: { maxHeight: "70%", marginTop: "auto", backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, paddingTop: spacing.lg }, sheetHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, paddingBottom: spacing.md }, sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" }, sheetSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 3 }, close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, modelList: { flexGrow: 0 }, modelOption: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }, modelOptionName: { color: colors.text, fontSize: 14, fontWeight: "600" }, noModels: { color: colors.textMuted, textAlign: "center", padding: spacing.xl } });

import { followTargetDefaultLabel, modelSelectorLabel } from "@/features/task/model-selector-presentation";
import { ConversationV3Background } from "@/features/interface/ConversationV3";
import { useNewTaskDraftAttachments } from "@/features/task/useNewTaskDraftAttachments";
import { catalogReadScopeKey, createNewCatalogReadSource, modelCatalogReadScopeKey } from "@/runtime/task-runtime/new-catalog-read-source";
import { reserveWorkspaceTaskHandoff, loadWorkspaceTaskHandoff, verifyWorkspaceTaskHandoff, confirmWorkspaceOpenDelivery } from "@/storage/pending-workspace-operation-v2";
import { loadPendingThreadCreation, originalCreationInput, pendingThreadCreationKey, readWorkspaceTaskHandoff, type PendingThreadCreation, type WorkspaceTaskHandoff } from "@/storage/pending-thread-creation";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { t } from "@/i18n";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { acknowledgeConfirmedWorkspaceOperation, loadConfirmedWorkspaceOperationReceipt, type WorkspaceOperationReceiptHandle } from "@/storage/pending-workspace-operation";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { WorkspaceOperationBookkeeping } from "@/features/forms/WorkspaceOperationBookkeeping";
import { useFormOwner, useFormState } from "@/features/forms/form-owner";
import type { DraftContextWorkspace, DraftContextWorkspaceSelection } from "@/features/task/DraftContextBar";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronLeft, Server as ServerIcon, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState } from "@/components/ui";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { defaultModelOption, modelOptionSelector, selectedModelOption, listModels, listWorkspaceOptions, prepareManagedWorktreeWithReceipt, TaskRuntime, taskRuntimeRegistry, type ModelOption, type WorkspaceOption } from "@/runtime/task-runtime";
import { useApp } from "@/state/AppContext";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import type { TaskCreationClaim } from "@/runtime/task-runtime/types";
import { loadNewWorkspacePreference, saveNewWorkspacePreference, reasoningEffortLabel, type NewWorkspacePreference, type WorkspaceIsolation } from "@/storage/new-workspace-preferences";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { claimWorkspaceAbsenceHandoff, peekWorkspaceAbsenceHandoff, revokeWorkspaceAbsenceHandoff, workspaceAbsenceHandoffParent } from "@/navigation/workspace-absence-handoff";
import { workspaceObservationPath } from "@/gateway/workspace-cwd-observation";
import { saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { useInterfaceVersion } from "@/storage/interface-version";
import { useLocale } from "@/i18n/use-locale";
import { NewTaskDraft } from "@/features/task/NewTaskDraft";
import { getGatewayDisplayState } from "@/components/settings/gateway-display-state";
import { KeyboardSafeView } from "@/components/keyboard-safe-view";
import { useNewTaskDraftConnection } from "@/features/task/useNewTaskDraftConnection";
import { useLastDraftProject, useRememberDraftProject } from "@/features/task/useLastDraftProject";
import { TaskExpertSelector } from "@/features/task/TaskExpertSelector";
import { listExpertsPage, listExpertVersions, type ExpertChoice } from "@/runtime/task-runtime/experts";
import type { PermissionMode } from "@/protocol/task-permission-mode";
import { consumeNewTaskDraftHandoff } from "@/navigation/new-task-draft-handoff";

export default function NewWorkspaceRoute() {
  const language = useLocale();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const v3 = version === "v3";
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ profileId?: string; serverId?: string; cwd?: string; draftHandoff?: string; draftRestoreFailed?: string; workspaceAbsenceHandoff?: string; operationReceiptId?: string; operationReceiptVersion?: string; operationKind?: string; operationSourcePath?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, markGatewayReauthorizationRequired, demo,
    runtimeActivationEpoch, isCurrentInteractionOwner, refresh } = useApp();
  const profileReady = hydrated && (!params.profileId || activeProfile?.id === params.profileId);
  const invalidProfile = hydrated && Boolean(params.profileId) && !profiles.some((profile) => profile.id === params.profileId);
  const [serverId, setSelectedServerId] = useState("");
  const server = useMemo(() => runtime.servers.find((item) => item.id === serverId), [runtime.servers, serverId]);
  const recentProject = useLastDraftProject(activeProfile, runtime.servers,
    v3 && !demo && profileReady && !runtime.loading && !runtime.reauthorizationRequired);
  const recentCwd = !params.serverId && recentProject.value?.serverId === server?.id ? recentProject.value?.cwd : undefined;
  const targetScope = activeProfile && server ? threadListScopeKey(activeProfile, server) : null;
  const catalogScope = activeProfile && server ? catalogReadScopeKey(activeProfile, server) : null;
  const currentCatalogScope = useRef(catalogScope);
  currentCatalogScope.current = catalogScope;
  const catalogAuthority = useRef({ profiles, activeProfile, profileReady, servers: runtime.servers, runtimeLoading: runtime.loading, reauthorizationRequired: runtime.reauthorizationRequired });
  catalogAuthority.current = { profiles, activeProfile, profileReady, servers: runtime.servers, runtimeLoading: runtime.loading, reauthorizationRequired: runtime.reauthorizationRequired };
  const routeIntentKey = JSON.stringify([params.profileId, params.serverId, params.cwd, params.draftHandoff, params.draftRestoreFailed, params.workspaceAbsenceHandoff, params.operationReceiptId, params.operationReceiptVersion, params.operationKind, params.operationSourcePath]);
  const gatewayScope = activeProfile ? profileAuthorizationScopeKey(activeProfile) : null;
  const owner = useFormOwner(JSON.stringify([routeIntentKey, profileReady, gatewayScope, targetScope, catalogScope, server?.observationTargetIdentity, runtime.reauthorizationRequired, demo]));
  const pendingDraftWorkspaceSelection = useRef<{
    token: object;
    sourceOwner: typeof owner;
    routeIntentKey: string;
    profileId: string;
    gatewayScope: string;
    serverId: string;
    path: string;
    targetScope: string;
    catalogScope: string;
    observationTargetIdentity: string | undefined;
  } | null>(null);
  // Keep unsent text when the user deliberately changes projects; profile/auth and route changes still fence it.
  const promptTargetIdentity = server ? JSON.stringify([targetScope, catalogScope, server.observationTargetIdentity]) : null;
  const manualPromptTarget = useRef<string | null>(null);
  const promptTargetFence = useRef<{ serverId: string | null; identity: string | null; epoch: number }>({ serverId: null, identity: null, epoch: 0 });
  if (server && promptTargetIdentity) {
    const previous = promptTargetFence.current;
    if (previous.serverId === server.id && previous.identity && previous.identity !== promptTargetIdentity) previous.epoch++;
    if (previous.serverId && previous.serverId !== server.id && manualPromptTarget.current !== server.id) previous.epoch++;
    if (manualPromptTarget.current === server.id) manualPromptTarget.current = null;
    previous.serverId = server.id; previous.identity = promptTargetIdentity;
  }
  const promptOwner = useFormOwner(JSON.stringify([routeIntentKey, profileReady, gatewayScope, runtime.reauthorizationRequired, promptTargetFence.current.epoch, demo]));
  const [prompt, setPrompt] = useFormState(promptOwner, "");
  const promptEditIntent = useRef<{ owner: typeof promptOwner; revision: number } | null>(null);
  if (promptEditIntent.current?.owner !== promptOwner) promptEditIntent.current = { owner: promptOwner, revision: 0 };
  const draftEditLock = useRef(false);
  const editPrompt = (update: SetStateAction<string>) => {
    if (!promptOwner.isCurrent() || draftEditLock.current) return;
    promptEditIntent.current!.revision++;
    setPrompt(update);
  };
  const routeTargetScope = JSON.stringify([gatewayScope, catalogScope]);
  const routedIntent = useRef<{ key: string; scope: string } | null>(null);
  if (profileReady && catalogScope && params.serverId === server?.id && params.cwd && (!routedIntent.current || routedIntent.current.key !== routeIntentKey)) {
    routedIntent.current = { key: routeIntentKey, scope: routeTargetScope };
  }
  const routedCwd = routedIntent.current?.key === routeIntentKey && routedIntent.current.scope === routeTargetScope
    ? params.cwd?.trim() : undefined;
  const absenceHandoff = !routedCwd && !demo && profileReady && activeProfile && server && !runtime.reauthorizationRequired
    ? peekWorkspaceAbsenceHandoff(params.workspaceAbsenceHandoff, "form", owner, activeProfile, server) : null;
  useEffect(() => {
    if (routedCwd || demo || runtime.reauthorizationRequired) revokeWorkspaceAbsenceHandoff(params.workspaceAbsenceHandoff);
    else if (profileReady && activeProfile && server)
      claimWorkspaceAbsenceHandoff(params.workspaceAbsenceHandoff, "form", owner, activeProfile, server);
  }, [owner, routedCwd, demo, runtime.reauthorizationRequired, profileReady, activeProfile, server, params.workspaceAbsenceHandoff]);
  const revokeAbsenceHandoff = () => revokeWorkspaceAbsenceHandoff(params.workspaceAbsenceHandoff, owner);
  const setServerId = (update: SetStateAction<string>) => {
    if (!owner.isCurrent()) return;
    setSelectedServerId((current) => {
      if (!owner.isCurrent()) return current;
      return typeof update === "function" ? update(current) : update;
    });
  };
  const goBack = () => {
    if (owner.isCurrent()) {
      backOrReplace(router, profileHomeHref(params.profileId ?? activeProfile?.id));
    }
  };
  const [cwd, setCwd] = useFormState(owner, recentCwd ?? "");
  const expertOwner = useFormOwner(JSON.stringify([owner.key, cwd.trim()]));
  const [expertSelection, setExpertSelection] = useFormState<ExpertChoice | null>(expertOwner, null);
  const [expertSelectorOpen, setExpertSelectorOpen] = useFormState(expertOwner, false);
  const [expertSelectionBusy, setExpertSelectionBusy] = useFormState(expertOwner, false);
  const expertSelectionBusyRef = useRef<{ owner: typeof expertOwner; busy: boolean }>({ owner: expertOwner, busy: false });
  if (expertSelectionBusyRef.current.owner !== expertOwner) expertSelectionBusyRef.current = { owner: expertOwner, busy: false };
  const modelWorkspacePath = cwd.trim() || routedCwd || server?.workspacePath;
  const modelCatalogScope = activeProfile && server ? modelCatalogReadScopeKey(activeProfile, server, modelWorkspacePath) : null;
  const modelReadOwner = useFormOwner(JSON.stringify([owner.key, modelCatalogScope]));
  const [workspaceOptions, setWorkspaceOptions] = useFormState<WorkspaceOption[]>(owner, []);
  const workspaceSelectionAuthority = useRef({
    owner, routeIntentKey, profileReady, isFocused, activeProfile, gatewayScope, serverId, server, cwd, routedCwd,
    workspaceOptions,
  });
  workspaceSelectionAuthority.current = {
    owner, routeIntentKey, profileReady, isFocused, activeProfile, gatewayScope, serverId, server, cwd, routedCwd,
    workspaceOptions,
  };
  const gatewayDisplayState = activeProfile ? getGatewayDisplayState(activeProfile, runtime) : "checking";
  const draftContextConnectionStatus = !profileReady || !activeProfile ? "checking"
    : gatewayDisplayState === "connected" ? "online" : gatewayDisplayState === "offline" ? "offline" : "checking";
  const draftContextWorkspaces = useMemo(() => {
    if (!profileReady || !activeProfile) return [];
    const options = new Map<string, DraftContextWorkspace>();
    for (const target of runtime.servers) {
      const path = target.workspacePath?.trim();
      if (!path) continue;
      options.set(JSON.stringify([target.id, path]), {
        serverId: target.id, serverLabel: target.label, path,
        label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      });
    }
    if (server?.id === serverId) {
      for (const item of workspaceOptions) {
        const path = item.path.trim();
        if (!path) continue;
        options.set(JSON.stringify([server.id, path]), {
          serverId: server.id, serverLabel: server.label, path, label: item.label,
        });
      }
    }
    return [...options.values()];
  }, [profileReady, activeProfile, runtime.servers, server, serverId, workspaceOptions]);
  const [workspacesLoading, setWorkspacesLoading] = useFormState(owner, false);
  const [workspaceCatalogError, setWorkspaceCatalogError] = useFormState<string | null>(owner, null);
  const [isolation, setIsolation] = useFormState<WorkspaceIsolation>(owner, "local");
  const [gitRef, setGitRef] = useFormState(owner, "");
  const [model, setModel] = useFormState(owner, "");
  const [explicitModelSelection, setExplicitModelSelection] = useFormState(owner, false);
  const modelSelectionIntent = useRef<{ owner: typeof owner; explicit: boolean; selection?: string; effortExplicit?: boolean } | null>(null);
  if (modelSelectionIntent.current?.owner !== owner) modelSelectionIntent.current = { owner, explicit: false };
  const chooseModel = (value: string, effort: string) => {
    if (!owner.isCurrent() || draftEditLock.current) return;
    modelSelectionIntent.current!.explicit = true;
    modelSelectionIntent.current!.selection = value;
    setExplicitModelSelection(true);
    modelSelectionIntent.current!.effortExplicit = false;
    setExplicitEffortSelection(false);
    setModel(value);
    setReasoningEffort(effort);
  };
  const [models, setModels] = useFormState<ModelOption[]>(owner, []);
  const [modelsLoading, setModelsLoading] = useFormState(owner, false);
  const [reasoningEffort, setReasoningEffort] = useFormState(owner, "");
  const permissionOwner = useFormOwner(JSON.stringify([routeIntentKey, gatewayScope, catalogScope, cwd]));
  const [permissionMode, setPermissionMode] = useFormState<PermissionMode>(permissionOwner, "default");
  const [explicitEffortSelection, setExplicitEffortSelection] = useFormState(owner, false);
  const [modelSheet, setModelSheet] = useFormState(owner, false);
  const [executionMode, setExecutionMode] = useFormState<'default' | 'orchestrate' | 'moa' | 'moa-plan'>(owner, 'default');
  const [loading, setLoading] = useFormState(owner, false);
  const [error, setError] = useFormState<string | null>(owner, null);
  const [catalogReadError, setCatalogReadError] = useFormState<string | null>(owner, null);
  const preferenceScope = activeProfile && server ? JSON.stringify([workspaceStateAuthorizationScope(activeProfile, server), activeProfile.deviceId ?? null]) : null;
  const [preferenceSaveError, setPreferenceSaveError] = useFormState<string | null>(owner, null);
  const [preferenceSaveRevision, setPreferenceSaveRevision] = useFormState(owner, 0);
  const [preferenceReadError, setPreferenceReadError] = useFormState<string | null>(owner, null);
  const [preferenceReadRevision, setPreferenceReadRevision] = useFormState(owner, 0);
  const [preferenceReadSuccess, setPreferenceReadSuccess] = useFormState(owner, false);
  const [preferenceApplied, setPreferenceApplied] = useFormState(owner, false);
  const [restoredPreference, setRestoredPreference] = useFormState<NewWorkspacePreference | null>(owner, null);
  const cwdEditIntentRef = useRef<{ owner: typeof owner; explicit: boolean } | null>(null);
  if (cwdEditIntentRef.current?.owner !== owner) cwdEditIntentRef.current = { owner, explicit: false };
  const cwdEditIntent = cwdEditIntentRef.current;
  const selectionIntentRef = useRef<{ owner: typeof owner; revision: number } | null>(null);
  if (selectionIntentRef.current?.owner !== owner) selectionIntentRef.current = { owner, revision: 0 };
  const selectionIntent = selectionIntentRef.current;
  const preferenceSaveIntentRef = useRef<{ owner: typeof owner; revision: number } | null>(null);
  if (preferenceSaveIntentRef.current?.owner !== owner) preferenceSaveIntentRef.current = { owner, revision: 0 };
  const preferenceSaveIntent = preferenceSaveIntentRef.current;
  const editCwd = (value: string) => { if (owner.isCurrent()) { revokeAbsenceHandoff(); cwdEditIntent.explicit = true; selectionIntent.revision++; setCwd(value); } };
  const editIsolation = (value: WorkspaceIsolation) => { if (owner.isCurrent()) { revokeAbsenceHandoff(); selectionIntent.revision++; setIsolation(value); } };
  useEffect(() => {
    const intent = pendingDraftWorkspaceSelection.current;
    if (!intent) return;
    const discard = () => { if (pendingDraftWorkspaceSelection.current?.token === intent.token) pendingDraftWorkspaceSelection.current = null; };
    if (!isFocused || !profileReady || !activeProfile || activeProfile.id !== intent.profileId || gatewayScope !== intent.gatewayScope || routeIntentKey !== intent.routeIntentKey) {
      discard();
      return;
    }
    if (serverId !== intent.serverId) {
      if (owner !== intent.sourceOwner) discard();
      return;
    }
    if (!server || owner === intent.sourceOwner || targetScope !== intent.targetScope || catalogScope !== intent.catalogScope ||
      server.observationTargetIdentity !== intent.observationTargetIdentity || server.workspacePath?.trim() !== intent.path) {
      discard();
      return;
    }
    discard();
    editCwd(intent.path);
  }, [owner, isFocused, profileReady, activeProfile?.id, gatewayScope, routeIntentKey, serverId, server, targetScope, catalogScope]);
  const [workspacesReady, setWorkspacesReady] = useFormState(owner, false);
  const [modelCatalogLoaded, setModelsReady] = useFormState(owner, false);
  const [modelPublicationOwner, setModelPublicationOwner] = useFormState<typeof modelReadOwner | null>(owner, null);
  const modelsReady = modelCatalogLoaded && modelPublicationOwner === modelReadOwner;
  const [catalogRevision, setCatalogRevision] = useFormState(owner, 0);
  const workspaceReadIdentity = useRef<{ owner: typeof owner; revision: number } | null>(null);
  const catalogsReady = workspacesReady && modelsReady;
  const visibleDefaultModel = modelsReady ? defaultModelOption(models) : undefined;
  const effortModel = explicitModelSelection && model ? selectedModelOption(models, model) : models.find(value => value.providerCurrent && value.isDefault);
  const effortChoiceUnavailable = modelsReady && explicitEffortSelection && Boolean(reasoningEffort) && !effortModel?.supportedReasoningEfforts?.includes(reasoningEffort);
  const modelChoiceUnavailable = modelsReady && explicitModelSelection && Boolean(model.trim()) && !selectedModelOption(models, model);
  const retryCatalogs = () => {
    if (!owner.isCurrent()) return;
    setWorkspacesReady(false);
    setModelsReady(false);
    setError(null);
    setCatalogReadError(null);
    setCatalogRevision((value) => value + 1);
  };
  const serverSignature = runtime.servers.map((item) => item.id).join("\0");
  const serverSelectionIntent = useRef<{ key: string; source: "unselected" | "route" | "manual" | "auto" | "recent" } | null>(null);
  const serverIntentKey = JSON.stringify([routeIntentKey, gatewayScope, profileReady]);
  if (serverSelectionIntent.current?.key !== serverIntentKey) serverSelectionIntent.current = { key: serverIntentKey, source: "unselected" };
  const closeModelSheet = () => setModelSheet(false);
  const modelSheetRef = useModalFocusTrap(modelSheet, closeModelSheet);

  useEffect(() => {
    if (owner.isCurrent() && shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: params.profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(params.profileId!);
    }
  }, [activeProfile?.id, hydrated, isFocused, params.profileId, profiles, setActiveProfile]);

  useEffect(() => {
    if (!owner.isCurrent()) return;
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
    const selection = serverSelectionIntent.current!;
    if (selection.source === "unselected") {
      if (v3 && !params.serverId && !recentProject.ready) return;
      const initial = params.serverId ? runtime.servers.find((item) => item.id === params.serverId)?.id ?? ""
        : recentProject.value?.serverId ?? (runtime.servers.length === 1 ? runtime.servers[0].id : "");
      selection.source = params.serverId ? "route" : recentProject.value ? "recent" : initial ? "auto" : "unselected";
      setServerId(initial);
      return;
    }
    if (selection.source === "auto" && runtime.servers.length !== 1) { selection.source = "unselected"; setServerId(""); return; }
    const fallback = !params.serverId && runtime.servers.length === 1 ? runtime.servers[0].id : "";
    if (fallback && !runtime.servers.some((item) => item.id === serverId)) selection.source = "auto";
    setServerId((current) => {
      if (current && runtime.servers.some((item) => item.id === current)) return current;
      return fallback;
    });
  }, [activeProfile?.id, params.serverId, profileReady, runtime.loading, serverSignature, serverIntentKey, v3, recentProject]);

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
        profileAuthorizationScopeKey(originalProfiles[0]) === gatewayScope && profileAuthorizationScopeKey(authority.activeProfile) === gatewayScope &&
        catalogReadScopeKey(originalProfiles[0], originalServers[0]) === catalogScope &&
        catalogReadScopeKey(authority.activeProfile, originalServers[0]) === catalogScope;
    }, { modelsWorkspacePath: modelWorkspacePath });
    const current = () => !controller.signal.aborted && owner.isCurrent() && modelReadOwner.isCurrent() && currentCatalogScope.current === catalogScope;
    const readWorkspaces = !workspacesReady || workspaceReadIdentity.current?.owner !== owner || workspaceReadIdentity.current.revision !== catalogRevision;
    if (readWorkspaces) {
      workspaceReadIdentity.current = { owner, revision: catalogRevision };
      setWorkspaceOptions([]);
      setWorkspacesLoading(true);
      setWorkspaceCatalogError(null);
      setWorkspacesReady(false);
    }
    setCatalogReadError(null);
    setModels([]);
    if (!modelSelectionIntent.current!.explicit) { setModel(""); if (!modelSelectionIntent.current!.effortExplicit) setReasoningEffort(""); }
    setModelsLoading(true);
    setModelsReady(false);
    // Both fixed candidates are registered synchronously. Only the real cache loaders acquire a client.
    const optionsPromise = source
      ? source.run("workspace", () => readWorkspaces ? listWorkspaceOptions(activeProfile, server, { signal: controller.signal }, source) : Promise.resolve(workspaceOptions))
      : Promise.resolve<WorkspaceOption[]>([{ path: server.workspacePath ?? "/data/projects/kcoder", label: "KCoder", kind: "workspace" }]);
    const modelsPromise = source
      ? source.run("models", () => listModels(activeProfile, server, { signal: controller.signal, source, workspacePath: modelWorkspacePath }))
      : Promise.resolve<ModelOption[]>([
        { id: "demo::MiniMax-M3", model: "MiniMax-M3", displayName: "MiniMax-M3", providerId: "kunlunmeta", providerName: "KCoder Meta", isDefault: true },
        { id: "demo::kimi-for-coding", model: "kimi-for-coding", displayName: "Kimi for Coding", providerId: "kimi", providerName: "Kimi" },
      ]);
    void optionsPromise.then(options => {
      if (!readWorkspaces || !current()) return;
      setWorkspaceOptions(options);
      if (selectionIntent.revision === 0 && !preferenceApplied) {
        const configuredWorkspace = server.workspacePath?.trim();
        const firstProject = options.find(option => option.path.trim())?.path;
        setCwd(routedCwd || recentCwd || configuredWorkspace || firstProject || "");
        setIsolation("local");
      }
      setWorkspacesReady(true);
    }).catch(value => {
      if (!readWorkspaces || !current()) return;
      if (selectionIntent.revision === 0 && !preferenceApplied) setCwd(routedCwd || recentCwd || server.workspacePath?.trim() || "");
      setWorkspaceCatalogError(value instanceof Error ? value.message : String(value));
      setCatalogReadError(value instanceof Error ? value.message : String(value));
    }).finally(() => { if (readWorkspaces && current()) setWorkspacesLoading(false); });
    void modelsPromise.then(values => {
      if (!current()) return;
      setModels(values);
      const selected = defaultModelOption(values);
      if (!modelSelectionIntent.current!.explicit) {
        setModel(demo ? "MiniMax-M3" : selected ? modelOptionSelector(selected) : "");
      }
      if (!modelSelectionIntent.current!.effortExplicit) {
        const effectiveModel = modelSelectionIntent.current!.explicit
          ? selectedModelOption(values, modelSelectionIntent.current!.selection ?? model)
          : selected;
        setReasoningEffort(demo && !modelSelectionIntent.current!.explicit ? "medium" : effectiveModel?.defaultReasoningEffort ?? "");
      }
      setModelsReady(true);
      setModelPublicationOwner(modelReadOwner);
    }).catch(value => { if (current()) setCatalogReadError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (current()) setModelsLoading(false); });
    // Abort this page's waiters. Other authorized waiters retain their cache controller's loader.
    return () => controller.abort();
  }, [owner, modelReadOwner, demo, profileReady, catalogRevision]);

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
    if (selectionIntent.revision === 0 && !routedCwd && (restoredPreference || recentCwd)) {
      const preference = recentCwd ? { cwd: recentCwd, isolation: "local" as const } : restoredPreference!;
      const currentHandoff = activeProfile && server ? claimWorkspaceAbsenceHandoff(params.workspaceAbsenceHandoff, "form", owner, activeProfile, server) : null;
      const avoidAbsentCwd = currentHandoff && workspaceObservationPath(preference.cwd) === currentHandoff.absentCwd;
      // The matched target's configured default is catalogued separately from registered projects.
      const recoveryParents = server?.workspacePath ? [...workspaceOptions, { path: server.workspacePath }] : workspaceOptions;
      // A recovery hint suppresses only this exact absent leaf. Other custom paths remain valid preferences.
      const restoredCwd = avoidAbsentCwd
        ? workspaceAbsenceHandoffParent(currentHandoff, recoveryParents) ?? ""
        : preference.cwd;
      setCwd(restoredCwd);
      setIsolation(avoidAbsentCwd || workspaceOptions.find((option) => option.path === preference.cwd)?.kind === "worktree" ? "local" : preference.isolation);
    }
    // Saving starts on the next render, after the restored selection has been committed.
    setPreferenceApplied(true);
  }, [owner, workspacesReady, preferenceReadSuccess, preferenceApplied, restoredPreference, routedCwd, recentCwd, workspaceOptions, absenceHandoff]);

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
    manualPromptTarget.current = nextServerId;
    serverSelectionIntent.current!.source = "manual";
    revokeAbsenceHandoff();
    const next = runtime.servers.find((item) => item.id === nextServerId);
    setServerId(nextServerId);
    setExecutionMode('default');
    setCwd(next?.workspacePath?.trim() ?? "");
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
  const [pendingOrdinary, setPendingOrdinary] = useFormState<PendingThreadCreation | null>(owner, null);
  const [ordinaryChecking, setOrdinaryChecking] = useFormState(owner, !demo);
  const [ordinaryRevision, setOrdinaryRevision] = useFormState(owner, 0);
  useEffect(() => {
    let current = true;
    setPendingOrdinary(null);
    if (demo || !profileReady || !activeProfile || !server || !cwd.trim()) { setOrdinaryChecking(false); return; }
    setOrdinaryChecking(true);
    void loadPendingThreadCreation(pendingThreadCreationKey(activeProfile, server, cwd.trim())).then(value => {
      if (current && owner.isCurrent()) setPendingOrdinary(value?.linked ? null : value);
    }).catch(value => { if (current && owner.isCurrent()) setError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (current && owner.isCurrent()) setOrdinaryChecking(false); });
    return () => { current = false; };
  }, [owner, cwd, profileReady, demo, ordinaryRevision]);
  draftEditLock.current = loading || Boolean(pendingOrdinary || pendingHandoff || pendingCreated);
  const workspaceSelectionBusy = useRef({ loading, pendingCreated: Boolean(pendingCreated), pendingHandoff: Boolean(pendingHandoff || pendingOrdinary) });
  workspaceSelectionBusy.current = { loading, pendingCreated: Boolean(pendingCreated), pendingHandoff: Boolean(pendingHandoff || pendingOrdinary) };
  const [handoffChecking, setHandoffChecking] = useFormState(owner, !demo);
  const [handoffError, setHandoffError] = useFormState<string | null>(owner, null);
  const [handoffRevision, setHandoffRevision] = useFormState(owner, 0);
  const createdContinuation = useRef<{ owner: typeof owner; value: NonNullable<typeof pendingCreated>; busy: boolean; navigated: boolean } | null>(null);
  if (createdContinuation.current?.owner !== owner) createdContinuation.current = null;
  const cwdReady = Boolean(server && cwd.trim() && (
    routedCwd === cwd.trim() ||
    recentCwd === cwd.trim() ||
    workspaceOptions.some((option) => option.path.trim() === cwd.trim()) ||
    server.workspacePath?.trim() === cwd.trim() ||
    cwdEditIntent.owner === owner && cwdEditIntent.explicit
  ));
  const selectDraftWorkspace = (selection: DraftContextWorkspaceSelection) => {
    const latest = workspaceSelectionAuthority.current;
    const authority = catalogAuthority.current;
    const busy = workspaceSelectionBusy.current;
    const path = selection.path.trim();
    if ((draftAttachments.items.length || draftAttachments.busy) && (selection.serverId !== server?.id || path !== cwd.trim())) { setError(t("new.draft_attachments_change_project")); return; }
    if (!path || !owner.isCurrent() || latest.owner !== owner || !latest.isFocused || !latest.profileReady || !latest.activeProfile || !activeProfile ||
      runtime.loading || runtime.reauthorizationRequired || busy.loading || busy.pendingCreated || busy.pendingHandoff ||
      !authority.profileReady || authority.runtimeLoading || authority.reauthorizationRequired ||
      authority.activeProfile?.id !== activeProfile.id || latest.activeProfile.id !== activeProfile.id ||
      profileAuthorizationScopeKey(latest.activeProfile) !== gatewayScope || latest.routeIntentKey !== routeIntentKey || latest.gatewayScope !== gatewayScope ||
      !gatewayScope || profileAuthorizationScopeKey(activeProfile) !== gatewayScope) return;

    const capturedProfile = activeProfile;
    const capturedTarget = runtime.servers.find((item) => item.id === selection.serverId);
    const currentProfile = authority.activeProfile;
    const currentProfileRecord = authority.profiles.find((item) => item.id === capturedProfile.id);
    const currentTarget = authority.servers.find((item) => item.id === selection.serverId);
    if (!capturedTarget || !currentProfile || !currentProfileRecord || !currentTarget ||
      profileAuthorizationScopeKey(currentProfile) !== gatewayScope || profileAuthorizationScopeKey(currentProfileRecord) !== gatewayScope ||
      threadListScopeKey(capturedProfile, capturedTarget) !== threadListScopeKey(currentProfile, currentTarget) ||
      catalogReadScopeKey(capturedProfile, capturedTarget) !== catalogReadScopeKey(currentProfile, currentTarget) ||
      capturedTarget.observationTargetIdentity !== currentTarget.observationTargetIdentity ||
      capturedTarget.workspacePath?.trim() !== currentTarget.workspacePath?.trim()) return;

    if (selection.serverId === latest.serverId && latest.server?.id === selection.serverId) {
      const option = latest.workspaceOptions.find((item) => item.path.trim() === path);
      if (!option && path !== latest.server.workspacePath?.trim() && path !== latest.routedCwd && path !== latest.cwd.trim()) return;
      editCwd(path);
      if (option?.kind === "worktree") editIsolation("local");
      return;
    }

    if (path !== capturedTarget.workspacePath?.trim() || path !== currentTarget.workspacePath?.trim()) return;
    const nextTargetScope = threadListScopeKey(currentProfile, currentTarget);
    const nextCatalogScope = catalogReadScopeKey(currentProfile, currentTarget);
    pendingDraftWorkspaceSelection.current = {
      token: {},
      sourceOwner: owner,
      routeIntentKey,
      profileId: currentProfile.id,
      gatewayScope,
      serverId: currentTarget.id,
      path,
      targetScope: nextTargetScope,
      catalogScope: nextCatalogScope,
      observationTargetIdentity: currentTarget.observationTargetIdentity,
    };
    selectServer(currentTarget.id);
  };
  const [draftRestoreNotice, setDraftRestoreNotice] = useFormState<string | null>(promptOwner, () => params.draftRestoreFailed === "1" ? t("new.draft_restore_unavailable") : null);
  const draftRestoreAttempt = useRef<{ owner: typeof owner; token: string } | null>(null);
  useEffect(() => {
    if (!params.draftHandoff || !owner.isCurrent() || !promptOwner.isCurrent() || !profileReady || !activeProfile || !server || runtime.loading || runtime.reauthorizationRequired || !params.cwd) return;
    if (draftRestoreAttempt.current?.owner === owner && draftRestoreAttempt.current.token === params.draftHandoff) return;
    draftRestoreAttempt.current = { owner, token: params.draftHandoff };
    const draft = consumeNewTaskDraftHandoff(params.draftHandoff, activeProfile, server, {
      profileId: params.profileId ?? activeProfile.id, serverId: params.serverId ?? server.id, cwd: params.cwd,
      operationReceiptId: params.operationReceiptId, operationReceiptVersion: params.operationReceiptVersion,
      operationKind: params.operationKind, operationSourcePath: params.operationSourcePath,
    });
    if (!draft) { setDraftRestoreNotice(t("new.draft_restore_unavailable")); return; }
    setDraftRestoreNotice(null);
    if (promptEditIntent.current!.revision === 0) setPrompt(draft.prompt);
    selectionIntent.revision++;
    setCwd(params.cwd);
    setExecutionMode(draft.executionMode);
    if (draft.modelExplicit) chooseModel(draft.model, draft.reasoningEffort);
    if (params.operationKind !== "worktree") { setIsolation(draft.isolation); setGitRef(draft.gitRef); }
  }, [owner, promptOwner, profileReady, runtime.loading, runtime.reauthorizationRequired, params.draftHandoff]);
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
        profileId: entry.value.profile.id, serverId: entry.value.server.id,
        threadId: entry.value.task.getSnapshot().threadId,
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
    draftEditLock.current = true;
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
      claim = TaskRuntime.claimCreation({ ...pending.linked!.input, reprepareInitialAttachments: pending.linked!.input.attachmentTransport === "legacy" && ["prepared","not-sent"].includes(pending.linked!.turn.phase), profile: activeProfile, server, workspaceHandoff: pendingHandoff,
        profileActivationEpoch: runtimeActivationEpoch, isCurrentInteractionOwner,
        onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, authorizationScope) }, taskRuntimeRegistry);
      const captured = claim; unregister = owner.onDispose(() => captured.release());
      const task = await claim.result;
      if (!owner.isCurrent()) return;
      if (!claim.adopt(taskRuntimeRegistry, activeProfile.id, server.id)) throw new Error(t("new.original_task_connection_released"));
      await retainCreated(task, pending.linked!.receipt, pendingHandoff, pending.linked!.sourcePath, pending.linked!.input.cwd);
    } catch (value) { if (owner.isCurrent()) setError(value instanceof Error ? value.message : String(value)); }
    finally { unregister?.(); claim?.release(); setLoading(false); }
  };

  const recoverOrdinary = async () => {
    if (!owner.isCurrent() || !pendingOrdinary || !activeProfile || !server || loading || !draftConnection.ready) return;
    setLoading(true); setError(null);
    let claim: TaskCreationClaim | undefined;
    let unregister: (() => void) | undefined;
    try {
      const input = originalCreationInput(pendingOrdinary);
      if (input.cwd !== cwd.trim()) throw new Error("Original task directory changed");
      const authorizationScope = profileAuthorizationScopeKey(activeProfile);
      claim = TaskRuntime.claimCreation({ ...input, reprepareInitialAttachments: input.attachmentTransport === "legacy" && !pendingOrdinary.turnDispatched, profile: activeProfile, server,
        isCurrentOwner: () => owner.isCurrent() && workspaceSelectionAuthority.current.isFocused && workspaceSelectionAuthority.current.cwd.trim() === input.cwd,
        profileActivationEpoch: runtimeActivationEpoch, isCurrentInteractionOwner,
        onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, authorizationScope) }, taskRuntimeRegistry);
      const captured = claim; unregister = owner.onDispose(() => captured.release());
      const task = await claim.result;
      if (!owner.isCurrent()) return;
      if (!claim.adopt(taskRuntimeRegistry, activeProfile.id, server.id)) throw new Error(t("new.task_creation_result_released"));
      router.replace({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: task.getSnapshot().threadId, cwd: input.cwd, title: task.getSnapshot().title } });
    } catch (value) { if (owner.isCurrent()) setError(value instanceof Error ? value.message : String(value)); }
    finally { unregister?.(); claim?.release(); setLoading(false); setOrdinaryRevision(value => value + 1); }
  };

  const create = async () => {
    if (draftEditLock.current || !modelReadOwner.isCurrent() || !expertOwner.isCurrent() || expertSelectionBusyRef.current.owner === expertOwner && expertSelectionBusyRef.current.busy || pendingOrdinary || ordinaryChecking || (!demo && !draftConnection.ready) || !owner.isCurrent() || createdContinuation.current?.owner === owner || pendingHandoff || handoffChecking || handoffError || loading || !catalogsReady || modelChoiceUnavailable || effortChoiceUnavailable || !profileReady || runtime.loading || runtime.reauthorizationRequired || modelsLoading || workspacesLoading || !activeProfile || !server || (!prompt.trim() && !draftAttachments.items.length) || draftAttachments.busy || !cwdReady) return;
    const selectedAgentDefinition = expertSelection ? { ...expertSelection.reference } : undefined;
    if (selectedAgentDefinition && (executionMode === "orchestrate" || !expertCreationSupported)) return;
    const capturedWorkspaceIdentity = captureWorkspaceProfileIdentity(activeProfile);
    selectionIntent.revision++;
    draftEditLock.current = true;
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
      if (draftAttachments.items.length && isolation !== "local") throw new Error(t("new.draft_attachments_worktree"));
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
      if (!owner.isCurrent()) return;
      const frozenAttachments = draftAttachments.freeze();
      const creationInput = { ...frozenAttachments, cwd: taskCwd, prompt: prompt.trim() || t("new.draft_attachment_only_prompt"), sessionMode: executionMode === 'orchestrate' ? 'orchestrate' as const : undefined, turnMode: executionMode === 'moa' || executionMode === 'moa-plan' ? executionMode : undefined, permissionMode, model: explicitModelSelection ? model.trim() || undefined : undefined, reasoningEffort: explicitModelSelection || explicitEffortSelection ? reasoningEffort || undefined : undefined, managedWorktreeSourcePath: isolation === "worktree" || params.operationKind === "worktree" && routedCwd === taskCwd ? server.workspacePath : undefined, ...(selectedAgentDefinition ? { agentDefinition: selectedAgentDefinition } : {}) };
      const handoff = workspaceReceipt?.version === 2 ? await reserveWorkspaceTaskHandoff(activeProfile, server, workspaceReceipt, creationInput) : undefined;
      if (handoff) setPendingHandoff(handoff);
      if (!owner.isCurrent()) return;
      const capturedAuthorizationScope = profileAuthorizationScopeKey(activeProfile);
      const task = demo ? TaskRuntime.demo(`demo-created-${Date.now()}`) : await (() => {
        claim = TaskRuntime.claimCreation({ ...creationInput, workspaceHandoff: handoff, profile: activeProfile, server,
          isCurrentOwner: () => owner.isCurrent() && workspaceSelectionAuthority.current.isFocused && workspaceSelectionAuthority.current.cwd.trim() === sourceCwd,
          profileActivationEpoch: runtimeActivationEpoch, isCurrentInteractionOwner,
          onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope) }, taskRuntimeRegistry);
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
      if (owner.isCurrent()) {
        setError(value instanceof Error ? value.message : String(value));
        try {
          const pending = activeProfile && server ? await loadPendingThreadCreation(pendingThreadCreationKey(activeProfile, server, cwd.trim())) : null;
          if (owner.isCurrent()) {
            setPendingOrdinary(pending?.linked ? null : pending);
            if (!pending && !pendingHandoff) await draftAttachments.unlockUnsent();
          }
        } catch { /* Keep frozen bytes when the original journal cannot be read. */ }
      }
    } finally {
      await draftAttachments.releaseUnclaimed().catch(() => {});
      unregisterClaim?.();
      claim?.release();
      setLoading(false);
    }
  };

  const actualDraftCwd = cwd || routedCwd || "";
  const draftConnection = useNewTaskDraftConnection(activeProfile, server, actualDraftCwd,
    !demo && profileReady && isFocused && !runtime.loading && !runtime.error && !runtime.reauthorizationRequired && cwdReady);
  const draftConnectionRef = useRef(draftConnection);
  draftConnectionRef.current = draftConnection;
  const expertCreationSupported = draftConnection.client?.supportsExperimental("agentDefinitionsV1") === true
    && draftConnection.client.supportsExperimental("threadCreationReceiptsV1") === true;
  const expertAvailability = demo ? "unsupported" as const : !profileReady || !server || !cwdReady || !preferenceApplied || !draftConnection.ready
    ? (draftConnection.error || runtime.error ? "disconnected" as const : "loading" as const)
    : !expertCreationSupported || executionMode === "orchestrate" ? "unsupported" as const : "ready" as const;
  const expertAvailabilityMessage = expertAvailability === "disconnected" ? draftConnection.error ?? runtime.error ?? t("task.disconnected")
    : expertAvailability === "unsupported" ? executionMode === "orchestrate" ? t("expert.default_session_required") : t("expert.creation_unavailable")
    : expertAvailability === "loading" ? t("expert.loading_directory") : undefined;
  const loadExpertDirectory = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    const connection = draftConnectionRef.current;
    const client = connection.client;
    const current = () => expertOwner.isCurrent() && owner.isCurrent() && isFocused
      && draftConnectionRef.current.owner === connection.owner && draftConnectionRef.current.client === client;
    if (!current() || !client || !expertCreationSupported || executionMode === "orchestrate") throw new Error(t(executionMode === "orchestrate" ? "expert.default_session_required" : "expert.creation_unavailable"));
    const page = await listExpertsPage(client, language, cursor ?? undefined, signal);
    if (signal.aborted || !current()) throw new Error(t("expert.directory_changed"));
    return page;
  }, [expertOwner, owner, isFocused, expertCreationSupported, executionMode, language]);
  const loadExpertVersions = useCallback(async (expertId: string, cursor: string | null, signal: AbortSignal) => {
    const connection = draftConnectionRef.current;
    const client = connection.client;
    const current = () => expertOwner.isCurrent() && owner.isCurrent() && isFocused
      && draftConnectionRef.current.owner === connection.owner && draftConnectionRef.current.client === client;
    if (!current() || !client || !expertCreationSupported || executionMode === "orchestrate") throw new Error(t(executionMode === "orchestrate" ? "expert.default_session_required" : "expert.creation_unavailable"));
    const page = await listExpertVersions(client, expertId, cursor ?? undefined, signal);
    if (signal.aborted || !current()) throw new Error(t("expert.directory_changed"));
    return page;
  }, [expertOwner, owner, isFocused, expertCreationSupported, executionMode, language]);
  const selectExpert = (choice: ExpertChoice | null) => {
    if (!expertOwner.isCurrent() || !owner.isCurrent() || !isFocused || draftEditLock.current || pendingOrdinary || pendingHandoff || pendingCreated || loading) return;
    if (choice && (executionMode === "orchestrate" || !expertCreationSupported)) return;
    setExpertSelection(choice);
  };
  const expertSelectionForDisplay = pendingOrdinary?.input?.agentDefinition
    ? { reference: pendingOrdinary.input.agentDefinition, title: pendingOrdinary.input.agentDefinition.version }
    : pendingHandoff ? undefined : ordinaryChecking || handoffChecking ? undefined : expertSelection;
  const expertSelector = !demo ? <TaskExpertSelector owner={expertOwner} selection={expertSelectionForDisplay}
    disabled={!expertOwner.isCurrent() || !owner.isCurrent() || !isFocused || loading || ordinaryChecking || handoffChecking || Boolean(pendingOrdinary || pendingHandoff || pendingCreated) || expertSelectionBusy || expertAvailability !== "ready" && !expertSelectionForDisplay}
    loadExperts={loadExpertDirectory} loadVersions={loadExpertVersions} onSelect={selectExpert} nextTurn={false}
    availability={expertAvailability} availabilityMessage={expertAvailabilityMessage}
    onOpenChange={open => { if (expertOwner.isCurrent()) setExpertSelectorOpen(open); }}
    onBusyChange={busy => { if (!expertOwner.isCurrent()) return; expertSelectionBusyRef.current = { owner: expertOwner, busy }; setExpertSelectionBusy(busy); }} /> : null;
  const draftConfigurationReady = demo || draftConnection.ready;
  useRememberDraftProject(activeProfile, server, actualDraftCwd,
    v3 && !demo && profileReady && isFocused && draftConnection.ready && cwdReady && !runtime.reauthorizationRequired);
  const draftAttachments = useNewTaskDraftAttachments(activeProfile, server, actualDraftCwd, draftConnection.client, promptOwner,
    !demo && profileReady && isFocused && !runtime.error && !runtime.reauthorizationRequired && isolation === "local");

  const draftContextScopeToken = useMemo(() => ({}), [owner, isFocused, activeProfile?.id, server?.id, actualDraftCwd]);

  const offlinePresentation = Boolean(server && !demo && (runtime.error || draftConnection.error));

  if (invalidProfile) {
    return <View style={[styles.root, { paddingTop: insets.top, backgroundColor: v3 ? "transparent" : offlinePresentation ? colors.surfaceRaised : colors.pageCanvas }]}><View style={styles.header}><Pressable accessibilityLabel={t("task.back")} onPress={goBack} style={styles.back}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{t("task.new_task")}</Text><View style={styles.headerSpacer} /></View><EmptyState icon={<ServerIcon size={42} color={colors.textDim} />} title={t("home.deleted_gateway_title")} body={t("new.removed_gateway_body")} /></View>;
  }

  return (
    <KeyboardSafeView style={[styles.root, { paddingTop: insets.top, backgroundColor: v3 ? "transparent" : offlinePresentation ? colors.surfaceRaised : colors.pageCanvas }]}>
      <ConversationV3Background />
      <View style={[styles.header, styles.draftHeader, v3 && { display: "none" }]}><Pressable accessibilityLabel={t("task.back")} onPress={goBack} style={[styles.back, offlinePresentation && { borderRadius: radius.lg }]}><ChevronLeft size={23} color={colors.text} /></Pressable>{classic ? <Text style={styles.headerTitle}>{t("task.new_task")}</Text> : null}<View style={styles.headerSpacer} /></View>
      <NewTaskDraft testID="new-task-draft" cwd={actualDraftCwd}
        onBack={goBack} onSettings={() => router.push("/settings")}
        onHistory={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile?.id } })}
        onProjects={() => router.push(profileHomeHref(activeProfile?.id) as never)}
        onInbox={activeProfile ? () => router.push({ pathname: "/h/[profileId]/inbox", params: { profileId: activeProfile.id } }) : undefined}
        onNew={profileReady ? () => { setExpertSelection(null); router.push({ pathname: "/new", params: { profileId: activeProfile?.id } }); } : undefined}
        contextActual={{
          scopeToken: draftContextScopeToken,
          profileId: activeProfile?.id ?? "",
          serverId: server?.id ?? "",
          connectionStatus: demo ? draftContextConnectionStatus : !hydrated ? "checking" : !activeProfile || !server || !cwdReady ? "offline" : draftConnection.ready ? "online" : draftConnection.error || runtime.error ? "offline" : "checking",
          cwd: actualDraftCwd,
          serverLabel: server?.label,
          projectLabel: draftContextWorkspaces.find((item) => item.serverId === server?.id && item.path === actualDraftCwd)?.label
            ?? (actualDraftCwd ? actualDraftCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? actualDraftCwd : t("new.draft_choose_project_action")),
        }}
        contextWorkspaces={draftContextWorkspaces} contextDefaultWorkspacePath={server?.workspacePath}
        contextWorkspacesReady={workspacesReady || !activeProfile && hydrated}
        contextWorkspacesError={runtime.error ?? workspaceCatalogError}
        contextRetry={!demo && (runtime.error || runtime.loading || draftConnection.error || catalogReadError || profileReady && server && cwdReady && !draftConnection.ready) ? {
          busy: loading || runtime.loading || runtime.reauthorizationRequired || !isFocused || workspacesLoading || modelsLoading || !runtime.error && !draftConnection.error && !catalogReadError && !draftConnection.ready,
          onRetry: async () => {
            if (!owner.isCurrent() || !isFocused || loading || runtime.loading || runtime.reauthorizationRequired || workspacesLoading || modelsLoading) return;
            if (runtime.error) await refresh();
            else if (draftConnection.error) draftConnection.retry();
            if (catalogReadError) retryCatalogs();
          },
        } : undefined}
        contextLocked={Boolean(pendingOrdinary) || !profileReady || runtime.loading || runtime.reauthorizationRequired || !isFocused || Boolean(pendingCreated || pendingHandoff)}
        onSelectWorkspace={selectDraftWorkspace} draftAttachments={draftAttachments}
        permissionMode={permissionMode} permissionsSupported={draftConnection.supportsPermissions}
        onSelectPermission={mode => { if (owner.isCurrent() && !draftEditLock.current && draftConnection.ready && (!loading && !pendingHandoff && !pendingCreated)) setPermissionMode(mode); }}
        workspaceStatus={workspacesLoading || modelsLoading ? t("new.draft_loading_options")
          : !server ? t("new.draft_select_server")
          : !cwd.trim() ? t("new.draft_choose_project")
          : !cwdReady ? t("new.draft_confirm_project") : undefined}
        modeLabel={executionMode === "default" ? undefined : executionMode === "orchestrate" ? "/orchestrate" : `/${executionMode}`}
        createsWorktree={isolation === "worktree"}
        input={prompt} setInput={editPrompt}
        expertSelector={expertSelector}
        expertSelectorOpen={expertSelectorOpen}
        expertSendLocked={expertSelectionBusy || Boolean(expertSelection && expertAvailability !== "ready")}
        draftEditable={v3 && profileReady && Boolean(activeProfile) && isFocused && !runtime.reauthorizationRequired && !draftEditLock.current}
        ready={draftConfigurationReady && catalogsReady && !modelChoiceUnavailable && !effortChoiceUnavailable && profileReady && !runtime.loading && !runtime.reauthorizationRequired && !modelsLoading && !workspacesLoading && cwdReady && !handoffChecking && !ordinaryChecking && !pendingOrdinary && !pendingCreated && !pendingHandoff && !handoffError}
        busy={loading} locked={Boolean(pendingOrdinary)} attachmentUnavailableReason={isolation === "worktree" ? t("new.draft_attachments_worktree") : undefined} modelPickerOpen={modelSheet} modelPickerReady={modelsReady && draftConfigurationReady && !pendingOrdinary && profileReady && !runtime.loading && !runtime.reauthorizationRequired && !modelsLoading && Boolean(server)} openModelPicker={() => { if (owner.isCurrent()) setModelSheet(true); }}
        modelLabel={modelSelectorLabel({ selection: model, selected: modelsReady ? selectedModelOption(models, model) : undefined, defaultModel: visibleDefaultModel, followDefault: !explicitModelSelection || !model.trim() })}
        reasoningEffort={!explicitModelSelection && !explicitEffortSelection ? "" : reasoningEffort} bottomInset={insets.bottom} submit={create}>
        <WorkspaceOperationBookkeeping profile={activeProfile} server={server} expectedResult={routedCwd} enabled={profileReady && !runtime.loading} />
        {draftRestoreNotice ? <Text testID="new-task-draft-restore-notice" accessibilityRole="alert" style={styles.fieldLabel}>{draftRestoreNotice}</Text> : null}
        {effortChoiceUnavailable ? <Text testID="new-task-reasoning-unavailable" accessibilityRole="alert" style={styles.error}>{t("new.draft_reasoning_unavailable")}</Text> : null}
        {modelChoiceUnavailable ? <Text testID="new-task-model-unavailable" accessibilityRole="alert" style={styles.error}>{t("new.draft_model_unavailable")}</Text> : null}
        {error ? <Text testID="new-workspace-error" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {handoffError ? <Text testID="workspace-task-handoff-error" accessibilityRole="alert" style={styles.error}>{handoffError}</Text> : null}
        {preferenceReadError ? <View><Text testID="new-workspace-preference-read-error" accessibilityRole="alert" style={styles.error}>{preferenceReadError}</Text><Button testID="retry-new-workspace-preference-read" variant="secondary" onPress={() => setPreferenceReadRevision(value => value + 1)}>{t("new.retry_read_preferences")}</Button></View> : null}
        {preferenceSaveError ? <View><Text testID="new-workspace-preference-error" accessibilityRole="alert" style={styles.error}>{preferenceSaveError}</Text><Button testID="retry-new-workspace-preference" variant="secondary" onPress={() => setPreferenceSaveRevision(value => value + 1)}>{t("new.retry_save_preferences")}</Button></View> : null}
        {pendingOrdinary ? <View testID="new-task-pending-submission"><Text style={styles.fieldLabel}>{t(pendingOrdinary.input?.attachmentTransport === "legacy" && !pendingOrdinary.turnDispatched ? "new.draft_reprepare_explanation" : "new.draft_pending_submission")}</Text><Button testID="recover-original-new-task" variant="secondary" disabled={loading || !draftConnection.ready} onPress={() => void recoverOrdinary()}>{t(pendingOrdinary.input?.attachmentTransport === "legacy" && !pendingOrdinary.turnDispatched ? "new.draft_reprepare_attachments" : "new.restore_original_task")}</Button></View> : null}
        {pendingHandoff && !pendingCreated ? <Button testID="recover-created-workspace-task" variant="secondary" disabled={loading || handoffChecking} onPress={() => void recoverOriginal()}>{t("new.restore_original_task")}</Button> : null}
        {handoffError ? <Button testID="retry-task-handoff-lookup" variant="secondary" disabled={handoffChecking || loading} onPress={() => setHandoffRevision(value => value + 1)}>{t("new.verify_original_task_handoff")}</Button> : null}
        {pendingCreated ? <Button testID="retry-created-workspace-scope" variant="secondary" disabled={loading} onPress={() => { const entry = createdContinuation.current; if (entry) void continueCreated(entry); }}>{t("new.continue_created_task")}</Button> : null}
        {loading && creationStage ? <Text testID="workspace-operation-stage" style={styles.fieldLabel}>{creationStage}</Text> : null}
      </NewTaskDraft>
      <Modal visible={modelSheet} transparent animationType="slide" onRequestClose={closeModelSheet}>
        <Pressable style={styles.sheetOverlay} onPress={closeModelSheet} />
        <View testID="new-task-model-sheet-content" ref={modelSheetRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.sheetHeader}><View><Text style={styles.sheetTitle}>{t("new.choose_model")}</Text><Text style={styles.sheetSubtitle}>{server?.label}</Text></View><Pressable accessibilityLabel={t("common.close")} onPress={() => setModelSheet(false)} style={styles.close}><X size={20} color={colors.textMuted} /></Pressable></View>
          <ScrollView style={styles.modelList}>
            <Button testID="new-model-server-default" variant="secondary" disabled={!modelsReady} onPress={() => { if (!modelsReady || !modelReadOwner.isCurrent()) return; chooseModel("", ""); setModelSheet(false); }}>{followTargetDefaultLabel(visibleDefaultModel)}</Button>
            {models.map((item) => (
              <Pressable key={item.id} testID={`new-model-option-${encodeURIComponent(item.id)}`} disabled={!modelsReady} accessibilityState={{ disabled: !modelsReady }} onPress={() => { if (!modelsReady || !modelReadOwner.isCurrent()) return; chooseModel(modelOptionSelector(item), item.defaultReasoningEffort ?? ""); setModelSheet(false); }} style={styles.modelOption}>
                <View style={styles.modelCopy}><Text style={styles.modelOptionName}>{item.displayName}</Text><Text style={styles.modelProvider}>{item.providerName}{item.supportsVision ? t("task.supports_images") : ""}</Text></View>
                {selectedModelOption(models, model)?.id === item.id ? <Check size={19} color={colors.green} /> : null}
              </Pressable>
            ))}
            {(effortModel?.supportedReasoningEfforts ?? []).map(effort =>
              <Pressable key={effort} testID={`new-reasoning-option-${effort}`} accessibilityRole="radio" aria-checked={reasoningEffort === effort}
                disabled={!modelsReady} accessibilityState={{ disabled: !modelsReady }} onPress={() => { if (!modelsReady || !modelReadOwner.isCurrent() || !owner.isCurrent() || draftEditLock.current) return; modelSelectionIntent.current!.effortExplicit = true; setExplicitEffortSelection(true); setReasoningEffort(effort); }} style={styles.modelOption}>
                <Text style={styles.modelOptionName}>{reasoningEffortLabel(effort)}</Text>{reasoningEffort === effort ? <Check size={18} color={colors.textMuted} /> : null}
              </Pressable>)}
            {models.length === 0 && !modelsLoading ? <Text style={styles.noModels}>{t("new.no_models")}</Text> : null}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardSafeView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  draftHeader: { justifyContent: "space-between" },
  draftHeaderTitle: { position: "absolute", left: 92, right: 92 },
  root: { flex: 1, backgroundColor: colors.pageCanvas },
  header: { height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg },
  back: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700", textAlign: "center" },
  headerSpacer: { width: 46 },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  modelCopy: { flex: 1 },
  modelProvider: { color: colors.textDim, fontSize: 11, marginTop: 3 },
  error: { color: colors.red, fontSize: 13 },
  sheetOverlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  sheet: { maxHeight: "70%", marginTop: "auto", backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, paddingTop: spacing.lg },
  sheetHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  sheetSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  modelList: { flexGrow: 0 },
  modelOption: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  modelOptionName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  noModels: { color: colors.textMuted, textAlign: "center", padding: spacing.xl },
});

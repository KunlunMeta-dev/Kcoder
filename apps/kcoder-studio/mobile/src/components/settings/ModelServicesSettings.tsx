import { Check, ChevronDown, ChevronUp, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { SettingsTargetChangedError, useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { requestConfirmation } from "@/platform/confirmation";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  conservativeProviderCapabilities,
  makeProviderUpsertParams,
  positiveInteger,
  providerProbeErrorCategory,
  providerSaveOutcomeUnknown,
  safeProviderEndpointLabel,
  providerTemplateDraft,
  PROVIDER_API_FORMATS,
  type ProviderProfile,
  type ProviderSettings,
  type ProviderSettingsDraft,
  type ProviderTemplate,
} from "./provider-settings";

const SETTINGS_CAPABILITY = "providerConfiguration";
const TEMPLATE_CAPABILITY = "providerTemplates";
const AUTH_POLICY_CAPABILITY = "providerAuthenticationPolicy";
const SAVE_CAPABILITY = "providerConnectionValidation";
const PROBE_CAPABILITY = "providerIndependentProbeV1";
const MODEL_CAPABILITY = "providerModelCapabilities";
const MULTI_MODEL_CAPABILITY = "qualifiedModelSelectionV1";
const DELETE_CAPABILITY = "providerDeletion";

type DraftMode = "new-provider" | "new-model" | "edit";
type DraftState = {
  identity: string;
  revision?: string;
  mode: DraftMode;
  value: ProviderSettingsDraft;
};
type TestOutcome = { identity: string; messageKey: string };
type RecoveryState = { identity: string; status: "refresh" | "review" };
type PendingDelete = {
  identity: string;
  revision?: string;
  profile: ProviderProfile;
  kind: "provider" | "model";
  replacement?: string;
};

const defaultDraft = (): ProviderSettingsDraft => ({
  id: "",
  apiFormat: "openai_chat_completions",
  endpoint: "",
  model: "",
  contextWindowTokens: "",
  maxOutputTokens: "",
  apiKey: "",
  authentication: "api_key",
  capabilities: conservativeProviderCapabilities,
  makeDefault: false,
  savedCredentialConfigured: false,
});

function errorKey(error: unknown, fallback: string, mutation = false): string {
  if (error instanceof SettingsTargetChangedError) {
    if (mutation && error.delivery === "unknown") return "settings_models.save_uncertain";
    return "settings_models.changed_refresh";
  }
  if (mutation && providerSaveOutcomeUnknown(error)) return "settings_models.save_uncertain";
  const category = providerProbeErrorCategory(error);
  return category ? `settings_models.error_${category}` : fallback;
}

function mutationOutcomeUnknown(error: unknown): boolean {
  if (error instanceof SettingsTargetChangedError) return error.delivery === "unknown";
  return providerSaveOutcomeUnknown(error);
}

function isRemotePlaintextEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function targetDescription(
  server: ReturnType<typeof useSettingsTarget>["server"],
  localLabel: string,
  sshLabel: string,
): string {
  if (!server) return "";
  const location = server.transport === "ssh"
    ? [server.user, server.host].filter(Boolean).join("@") || server.host || sshLabel
    : localLabel;
  return `${server.label} · ${location}`;
}

export function ModelServicesSettings() {
  const target = useSettingsTarget();
  const router = useRouter();
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const identity = target.targetIdentity;
  const identityRef = useRef(identity);
  const readyRef = useRef(target.ready);
  identityRef.current = identity;
  readyRef.current = target.ready;

  const [settingsState, setSettingsState] = useState<{ identity: string; value: ProviderSettings } | null>(null);
  const [templatesState, setTemplatesState] = useState<{ identity: string; value: ProviderTemplate[] } | null>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [capabilitiesExpanded, setCapabilitiesExpanded] = useState(false);
  const [deleteState, setDeleteState] = useState<PendingDelete | null>(null);
  const [errorState, setErrorState] = useState<{ identity: string; key: string } | null>(null);
  const [noticeState, setNoticeState] = useState<{ identity: string; key: string } | null>(null);
  const [testState, setTestState] = useState<TestOutcome | null>(null);
  const [recoveryState, setRecoveryState] = useState<RecoveryState | null>(null);
  const [loadingIdentity, setLoadingIdentity] = useState<string | null>(null);
  const [busyIdentity, setBusyIdentity] = useState<string | null>(null);
  const targetGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const targetScope = useRef<string | null>(null);
  const refreshInFlight = useRef(false);
  const refreshRequestGeneration = useRef(0);
  const draftRevision = useRef(0);
  const busyRef = useRef(false);

  const settings = settingsState?.identity === identity ? settingsState.value : null;
  const templates = templatesState?.identity === identity ? templatesState.value : [];
  const draftEntry = draftState?.identity === identity ? draftState : null;
  const draft = draftEntry?.value ?? null;
  const pendingDelete = deleteState?.identity === identity ? deleteState : null;
  const error = errorState?.identity === identity ? errorState.key : null;
  const notice = noticeState?.identity === identity ? noticeState.key : null;
  const outcome = testState?.identity === identity ? testState.messageKey : null;
  const recovery = recoveryState?.identity === identity ? recoveryState.status : null;
  const loading = Boolean(identity) && loadingIdentity === identity;
  const busy = Boolean(identity) && busyIdentity === identity;

  const appServerCapabilities = target.capabilities.appServer?.experimental;
  const supportsSettings = appServerCapabilities?.[SETTINGS_CAPABILITY] === true;
  const supportsTemplates = appServerCapabilities?.[TEMPLATE_CAPABILITY] === true;
  const supportsAuthenticationPolicy = appServerCapabilities?.[AUTH_POLICY_CAPABILITY] === true;
  const supportsSave = appServerCapabilities?.[SAVE_CAPABILITY] === true;
  const supportsIndependentProbe = appServerCapabilities?.[PROBE_CAPABILITY] === true;
  const supportsModelCapabilities = appServerCapabilities?.[MODEL_CAPABILITY] === true;
  const supportsMultipleModels = appServerCapabilities?.[MULTI_MODEL_CAPABILITY] === true;
  const supportsDeletion = appServerCapabilities?.[DELETE_CAPABILITY] === true;
  const canUseIndependentProbe = supportsIndependentProbe && settings?.supportsIndependentProbe === true;

  const assertCurrentTarget = useCallback((
    capturedIdentity: string,
    delivery: "not-sent" | "unknown" = "not-sent",
  ) => {
    if (!capturedIdentity || identityRef.current !== capturedIdentity || !readyRef.current)
      throw new SettingsTargetChangedError(delivery);
  }, []);

  const reload = useCallback(async (capturedIdentity: string, generation: number) => {
    assertCurrentTarget(capturedIdentity);
    const [nextSettings, nextTemplates] = await Promise.all([
      target.request<ProviderSettings>("runtime.providers.list", {}),
      supportsTemplates
        ? target.request<{ templates?: ProviderTemplate[] }>("runtime.providers.templates", {})
        : Promise.resolve({ templates: [] as ProviderTemplate[] }),
    ]);
    assertCurrentTarget(capturedIdentity, "unknown");
    if (targetGeneration.current !== generation) return;
    setSettingsState({
      identity: capturedIdentity,
      value: { ...nextSettings, profiles: Array.isArray(nextSettings.profiles) ? nextSettings.profiles : [] },
    });
    setTemplatesState({ identity: capturedIdentity, value: Array.isArray(nextTemplates.templates) ? nextTemplates.templates : [] });
    setDraftState(current => {
      if (current?.identity !== capturedIdentity || current.revision) return current;
      return { ...current, revision: nextSettings.revision };
    });
    return nextSettings;
  }, [assertCurrentTarget, supportsTemplates, target.request]);

  useEffect(() => {
    const nextScope = identity && target.serverId
      ? JSON.stringify([identity, target.serverId])
      : null;
    if (targetScope.current === nextScope) return;
    targetScope.current = nextScope;
    targetGeneration.current += 1;
    refreshRequestGeneration.current += 1;
    refreshInFlight.current = false;
    draftRevision.current += 1;
    busyRef.current = false;
    setLoadingIdentity(null);
    setBusyIdentity(null);
    setSettingsState(null);
    setTemplatesState(null);
    setDraftState(null);
    setCapabilitiesExpanded(false);
    setDeleteState(null);
    setErrorState(null);
    setNoticeState(null);
    setTestState(null);
    setRecoveryState(null);
  }, [identity, target.serverId]);

  useEffect(() => {
    const attempt = ++loadGeneration.current;
    if (!identity || !target.serverId || !target.ready) {
      setLoadingIdentity(null);
      return () => {
        if (loadGeneration.current === attempt) loadGeneration.current += 1;
      };
    }
    const generation = targetGeneration.current;
    if (!supportsSettings) {
      setLoadingIdentity(null);
      setErrorState({ identity, key: "settings_models.unsupported" });
      return () => {
        if (loadGeneration.current === attempt) loadGeneration.current += 1;
      };
    }
    setLoadingIdentity(identity);
    void reload(identity, generation)
      .catch(failure => {
        if (
          identityRef.current === identity &&
          targetGeneration.current === generation &&
          loadGeneration.current === attempt
        ) setErrorState({ identity, key: errorKey(failure, "settings_models.load_failed") });
      })
      .finally(() => {
        if (loadGeneration.current === attempt) setLoadingIdentity(null);
      });
    return () => {
      if (loadGeneration.current === attempt) loadGeneration.current += 1;
    };
  }, [identity, reload, supportsSettings, target.ready, target.serverId]);

  const setError = (key: string | null) => {
    if (!identity) return;
    setErrorState(key ? { identity, key } : null);
    if (key) setNoticeState(null);
  };
  const setNotice = (key: string | null) => {
    if (!identity) return;
    setNoticeState(key ? { identity, key } : null);
    if (key) setErrorState(null);
  };
  const setBusy = (value: boolean) => {
    busyRef.current = value;
    setBusyIdentity(value && identity ? identity : null);
  };

  const startNewProvider = () => {
    if (!identity || !target.ready || !settings || busyRef.current || loading || recovery) return;
    draftRevision.current += 1;
    setCapabilitiesExpanded(false);
    setDraftState({ identity, revision: settings.revision, mode: "new-provider", value: defaultDraft() });
    setDeleteState(null);
    setTestState(null);
    setError(null);
    setNotice(null);
  };

  const startFromTemplate = (template: ProviderTemplate) => {
    if (!identity || !target.ready || !settings || busyRef.current || loading || recovery) return;
    draftRevision.current += 1;
    setCapabilitiesExpanded(false);
    setDraftState({ identity, revision: settings.revision, mode: "new-provider", value: providerTemplateDraft(template) });
    setDeleteState(null);
    setTestState(null);
    setError(null);
    setNotice(null);
  };

  const startEdit = (profile: ProviderProfile, addModel = false) => {
    if (!identity || !target.ready || !settings || busyRef.current || loading || recovery) return;
    draftRevision.current += 1;
    setCapabilitiesExpanded(false);
    const supportsModels = settings.supportsMultipleModels === true && supportsMultipleModels;
    setDraftState({
      identity,
      revision: settings.revision,
      mode: addModel ? "new-model" : "edit",
      value: {
        id: profile.id,
        apiFormat: profile.apiFormat,
        endpoint: profile.endpoint,
        model: addModel ? "" : profile.model,
        contextWindowTokens: String(addModel ? "" : profile.contextWindowTokens),
        maxOutputTokens: String(addModel ? "" : profile.maxOutputTokens),
        apiKey: "",
        authentication: profile.authentication?.mode ?? "api_key",
        capabilities: addModel ? conservativeProviderCapabilities : profile.capabilities,
        makeDefault: addModel ? false : profile.isDefault,
        ...(supportsModels && !addModel ? { originalModel: profile.model } : {}),
        savedCredentialConfigured: profile.apiKeyConfigured,
      },
    });
    setDeleteState(null);
    setTestState(null);
    setError(null);
    setNotice(null);
  };

  const updateDraft = <K extends keyof ProviderSettingsDraft>(field: K, value: ProviderSettingsDraft[K]) => {
    if (!identity || !draftEntry || !readyRef.current || busyRef.current || loading || recovery) return;
    draftRevision.current += 1;
    setDraftState({ ...draftEntry, value: { ...draftEntry.value, [field]: value } });
    setTestState(null);
    setError(null);
    setNotice(null);
  };

  const save = async (approvedPlaintextEndpoint?: string) => {
    if (!identity || !target.ready || !draft || !draftEntry || !settings || busyRef.current || loading || recovery) return;
    const currentIdentity = identity;
    const generation = targetGeneration.current;
    if (settings.supportsOptimisticConcurrency && !draftEntry.revision) {
      setError("settings_models.changed_refresh");
      return;
    }
    const providerId = draft.id.trim();
    const modelName = draft.model.trim();
    if (!providerId) {
      setError("settings_models.provider_required");
      return;
    }
    if (!modelName) {
      setError("settings_models.model_required");
      return;
    }
    if (!PROVIDER_API_FORMATS.includes(draft.apiFormat)) {
      setError("settings_models.save_failed");
      return;
    }
    const contextWindowTokens = positiveInteger(draft.contextWindowTokens);
    const maxOutputTokens = positiveInteger(draft.maxOutputTokens);
    if (contextWindowTokens === null || maxOutputTokens === null) {
      setError(
        draft.contextWindowTokens.trim() === "" || draft.maxOutputTokens.trim() === ""
          ? "settings_models.limits_required"
          : "settings_models.invalid_number",
      );
      return;
    }
    if (contextWindowTokens < 1024 || contextWindowTokens > 100_000_000 || maxOutputTokens >= contextWindowTokens) {
      setError("settings_models.limits_invalid");
      return;
    }
    if (draftEntry.mode === "new-provider" && settings.profiles.some(profile => profile.id === providerId)) {
      setError("settings_models.save_failed");
      return;
    }
    if (settings.supportsMultipleModels && settings.profiles.some(profile =>
      profile.id === providerId && profile.model === modelName && profile.model !== draft.originalModel,
    )) {
      setError("settings_models.save_failed");
      return;
    }
    if (!supportsSave) {
      setError("settings_models.unsupported");
      return;
    }
    const endpoint = draft.endpoint.trim();
    if (isRemotePlaintextEndpoint(endpoint) && approvedPlaintextEndpoint !== endpoint) {
      setError("settings_models.unencrypted_endpoint");
      return;
    }
    const requestGenerationAtStart = generation;
    const requestDraftRevision = draftRevision.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      assertCurrentTarget(currentIdentity);
      const result = await target.request<ProviderSettings>("runtime.providers.upsert", makeProviderUpsertParams(
        draft,
        contextWindowTokens,
        maxOutputTokens,
        {
          expectedRevision: settings.supportsOptimisticConcurrency ? draftEntry.revision : undefined,
          independentProbe: canUseIndependentProbe,
          supportsAuthenticationPolicy,
          supportsModelCapabilities: supportsModelCapabilities && settings.supportsModelCapabilities === true,
          supportsMultipleModels: supportsMultipleModels && settings.supportsMultipleModels === true,
        },
      ));
      assertCurrentTarget(currentIdentity, "unknown");
      if (
        targetGeneration.current !== requestGenerationAtStart ||
        draftRevision.current !== requestDraftRevision
      ) return;
      const nextSettings = { ...result, profiles: Array.isArray(result.profiles) ? result.profiles : [] };
      setSettingsState({ identity: currentIdentity, value: nextSettings });
      setDraftState({
        ...draftEntry,
        revision: nextSettings.savedRevision ?? nextSettings.revision,
        mode: "edit",
        value: {
          ...draft,
          id: providerId,
          model: modelName,
          endpoint,
          apiKey: "",
          originalModel: settings.supportsMultipleModels ? modelName : undefined,
          savedCredentialConfigured: draft.apiKey.trim().length > 0 || draft.savedCredentialConfigured,
        },
      });
      setTestState(null);
      setNotice("settings_models.save_success");
    } catch (failure) {
      if (
        identityRef.current === currentIdentity &&
        targetGeneration.current === requestGenerationAtStart &&
        draftRevision.current === requestDraftRevision
      ) {
        if (mutationOutcomeUnknown(failure)) {
          setRecoveryState({ identity: currentIdentity, status: "refresh" });
          setError(null);
        } else setError(errorKey(failure, "settings_models.save_failed", true));
      }
    } finally {
      if (targetGeneration.current === requestGenerationAtStart) setBusy(false);
    }
  };

  const onSave = () => {
    if (!draft || busyRef.current || loading || recovery || !target.ready) return;
    const endpoint = draft.endpoint.trim();
    if (!isRemotePlaintextEndpoint(endpoint)) {
      void save();
      return;
    }
    const capturedIdentity = identity;
    const generation = targetGeneration.current;
    const capturedDraftRevision = draftRevision.current;
    if (!capturedIdentity) return;
    requestConfirmation({
      title: t("settings_models.confirm_http_title"),
      message: t("settings_models.unencrypted_endpoint"),
      confirmLabel: t("settings_models.confirm_http"),
      cancelLabel: t("settings_models.cancel"),
      onConfirm: () => {
        if (
          targetGeneration.current === generation &&
          identityRef.current === capturedIdentity &&
          draftRevision.current === capturedDraftRevision
        )
          void save(endpoint);
        else if (identityRef.current === capturedIdentity)
          setError("settings_models.draft_changed");
      },
    });
  };

  const draftSavedProfile = useMemo(() => {
    if (!draft || !draftEntry || !settings || draftEntry.mode === "new-provider" || draftEntry.mode === "new-model") return null;
    return settings.profiles.find(profile =>
      profile.id === draft.id && profile.model === draft.model &&
      profile.endpoint === draft.endpoint && profile.apiFormat === draft.apiFormat &&
      profile.contextWindowTokens === positiveInteger(draft.contextWindowTokens) &&
      profile.maxOutputTokens === positiveInteger(draft.maxOutputTokens),
    ) ?? null;
  }, [draft, settings]);
  const canTestCurrentDraft = Boolean(
    canUseIndependentProbe &&
    draftSavedProfile && draft && !draft.apiKey.trim(),
  );

  const testConnection = async () => {
    if (!identity || !target.ready || !draft || !draftSavedProfile || !settings?.revision || busyRef.current || loading || recovery || !canUseIndependentProbe || !canTestCurrentDraft) return;
    const currentIdentity = identity;
    const generation = targetGeneration.current;
    const capturedDraftRevision = draftRevision.current;
    const profile = draftSavedProfile;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestState(null);
    try {
      assertCurrentTarget(currentIdentity);
      const result = await target.request<{
        provider: string;
        model: string;
        revision: string;
        configurationRevision: string;
        success: boolean;
        errorType?: string;
      }>("runtime.providers.probe", {
        id: profile.id,
        model: profile.model,
        expectedRevision: settings.revision,
        ...(profile.nextTurnConfiguration?.revision
          ? { expectedConfigurationRevision: profile.nextTurnConfiguration.revision }
          : {}),
      });
      assertCurrentTarget(currentIdentity, "unknown");
      if (targetGeneration.current !== generation || draftRevision.current !== capturedDraftRevision) return;
      if (
        result.revision !== settings.revision || result.provider !== profile.id ||
        result.model !== profile.model ||
        (profile.nextTurnConfiguration?.revision && result.configurationRevision !== profile.nextTurnConfiguration.revision)
      ) {
        setError("settings_models.test_result_changed");
        return;
      }
      setTestState({
        identity: currentIdentity,
        messageKey: result.success
          ? "settings_models.test_success"
          : `settings_models.test_failed:${safeErrorCategory(result.errorType)}`,
      });
    } catch (failure) {
      if (
        identityRef.current === currentIdentity &&
        targetGeneration.current === generation &&
        draftRevision.current === capturedDraftRevision
      ) {
        if (failure instanceof SettingsTargetChangedError) {
          setError("settings_models.changed_refresh");
          return;
        }
        const category = providerProbeErrorCategory(failure);
        setTestState({ identity: currentIdentity, messageKey: `settings_models.error_${category ?? "configuration"}` });
      }
    } finally {
      if (targetGeneration.current === generation) setBusy(false);
    }
  };

  const openDelete = (profile: ProviderProfile) => {
    if (!identity || !target.ready || !settings || busyRef.current || loading || recovery || !supportsDeletion || !profile.canDelete) return;
    draftRevision.current += 1;
    const sameProvider = settings.profiles.filter(item => item.id === profile.id);
    const kind = supportsMultipleModels && settings.supportsMultipleModels && sameProvider.length > 1
      ? "model"
      : "provider";
    setDeleteState({ identity, revision: settings.revision, profile, kind });
    setDraftState(null);
    setTestState(null);
    setError(null);
    setNotice(null);
  };

  const confirmDelete = async () => {
    if (!identity || !pendingDelete || !settings || busyRef.current || loading || recovery) return;
    const currentIdentity = identity;
    const generation = targetGeneration.current;
    const deletion = pendingDelete;
    let deleteRequestStarted = false;
    const needsReplacement = deletion.kind === "model"
      ? deletion.profile.isDefault === true || deletion.profile.isProviderDefault === true
      : deletion.profile.isDefault === true;
    if (needsReplacement && !deletion.replacement) {
      setError("settings_models.replacement_required");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      assertCurrentTarget(currentIdentity);
      const fresh = await target.request<ProviderSettings>("runtime.providers.list", {});
      assertCurrentTarget(currentIdentity);
      if (targetGeneration.current !== generation) return;
      if (deletion.revision && fresh.revision !== deletion.revision) {
        setSettingsState({ identity: currentIdentity, value: { ...fresh, profiles: Array.isArray(fresh.profiles) ? fresh.profiles : [] } });
        setDeleteState(null);
        setError("settings_models.changed_refresh");
        return;
      }
      if (!fresh.profiles?.some(item => item.id === deletion.profile.id && item.model === deletion.profile.model && item.canDelete)) {
        setSettingsState({ identity: currentIdentity, value: { ...fresh, profiles: Array.isArray(fresh.profiles) ? fresh.profiles : [] } });
        setDeleteState(null);
        setError("settings_models.changed_refresh");
        return;
      }
      const params: Record<string, unknown> = {
        id: deletion.profile.id,
        confirm: true,
        removeCredentials: false,
      };
      if (deletion.kind === "model") {
        params.model = deletion.profile.model;
        if (needsReplacement) params.replacementModel = deletion.replacement;
      } else if (needsReplacement) {
        params.replacementProvider = deletion.replacement;
      }
      const deleteRequest = target.request<ProviderSettings>("runtime.providers.delete", params);
      deleteRequestStarted = true;
      const next = await deleteRequest;
      assertCurrentTarget(currentIdentity, "unknown");
      if (targetGeneration.current !== generation) return;
      setSettingsState({ identity: currentIdentity, value: { ...next, profiles: Array.isArray(next.profiles) ? next.profiles : [] } });
      setDeleteState(null);
      setDraftState(null);
      setNotice(next.warning ? "settings_models.delete_warning" : "settings_models.delete_success");
    } catch (failure) {
      if (identityRef.current === currentIdentity && targetGeneration.current === generation) {
        if (deleteRequestStarted && mutationOutcomeUnknown(failure)) {
          setRecoveryState({ identity: currentIdentity, status: "refresh" });
          setDeleteState(null);
          setError(null);
        } else setError(errorKey(failure, "settings_models.delete_failed", deleteRequestStarted));
      }
    } finally {
      if (targetGeneration.current === generation) setBusy(false);
    }
  };

  const deleteProviderOptions = useMemo(() => {
    if (!settings || !pendingDelete) return [] as string[];
    return [...new Set(settings.profiles
      .filter(profile => profile.id !== pendingDelete.profile.id && profile.canDelete)
      .map(profile => profile.id))];
  }, [pendingDelete, settings]);
  const deleteModelOptions = useMemo(() => settings?.profiles
    .filter(profile => profile.id === pendingDelete?.profile.id && profile.model !== pendingDelete.profile.model)
    .map(profile => profile.model) ?? [], [pendingDelete, settings]);
  const needsDeleteReplacement = pendingDelete
    ? pendingDelete.kind === "model"
      ? pendingDelete.profile.isDefault === true || pendingDelete.profile.isProviderDefault === true
      : pendingDelete.profile.isDefault === true
    : false;
  const replacementOptions = pendingDelete?.kind === "model" ? deleteModelOptions : deleteProviderOptions;
  const canConfirmDelete = !needsDeleteReplacement || Boolean(pendingDelete?.replacement);

  const refreshSettings = async () => {
    if (!identity || !target.ready || !supportsSettings || busyRef.current || loading) return;
    const currentIdentity = identity;
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const refreshAttempt = ++refreshRequestGeneration.current;
    const generation = ++targetGeneration.current;
    const loadAttempt = ++loadGeneration.current;
    setLoadingIdentity(currentIdentity);
    setError(null);
    try {
      const refreshed = await reload(currentIdentity, generation);
      if (!refreshed || identityRef.current !== currentIdentity || targetGeneration.current !== generation) return;
      setDraftState(current => {
        if (current?.identity !== currentIdentity) return current;
        const matchingProfile = Array.isArray(refreshed.profiles)
          ? refreshed.profiles.find(profile => profile.id === current.value.id && profile.model === current.value.model)
          : undefined;
        return matchingProfile
          ? { ...current, value: { ...current.value, savedCredentialConfigured: matchingProfile.apiKeyConfigured } }
          : current;
      });
      setRecoveryState(current => current?.identity === currentIdentity && current.status === "refresh"
        ? { ...current, status: "review" }
        : current);
    } catch (failure) {
      if (
        identityRef.current === currentIdentity &&
        targetGeneration.current === generation &&
        loadGeneration.current === loadAttempt
      )
        setError(errorKey(failure, "settings_models.load_failed"));
    } finally {
      if (targetGeneration.current === generation && loadGeneration.current === loadAttempt)
        setLoadingIdentity(null);
      if (refreshRequestGeneration.current === refreshAttempt) refreshInFlight.current = false;
    }
  };

  const acknowledgeRecoveryReview = () => {
    if (!identity || recovery !== "review" || !settings || busyRef.current) return;
    draftRevision.current += 1;
    setDraftState(current => current?.identity === identity
      ? { ...current, revision: settings.revision }
      : current);
    setDeleteState(current => current?.identity === identity ? null : current);
    setRecoveryState(null);
    setError(null);
    setNotice(null);
    setTestState(null);
  };

  const actualTarget = targetDescription(
    target.server,
    t("settings_models.local_target"),
    t("settings_models.ssh_target"),
  );
  const targetContext = target.profile?.label
    ? `${target.profile.label} · ${actualTarget}`
    : actualTarget;
  const showLoading = !identity || !target.serverId
    ? false
    : target.loading || (target.ready && loading);

  const renderField = (
    label: string,
    value: string,
    onChangeText: (next: string) => void,
    testID: string,
    options: { secure?: boolean; keyboard?: "default" | "numeric"; placeholder?: string; multiline?: boolean } = {},
  ) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={options.secure}
        keyboardType={options.keyboard}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={options.multiline}
        editable={!busy && !loading && !recovery && target.ready}
        placeholder={options.placeholder}
        placeholderTextColor={colors.textDim}
        selectionColor={colors.blue}
        style={[styles.input, options.multiline && styles.multilineInput]}
      />
    </View>
  );

  return (
    <View testID="model-services-settings" style={styles.root}>
      <SettingsGroup title={t("settings_models.target")} testID="models-target-summary">
        <View style={styles.targetBody}>
          <View style={styles.targetHeading}>
            <Server size={18} color={colors.textMuted} />
            <Text testID="models-target-name" style={styles.targetName} numberOfLines={2}>
              {targetContext || t("settings_models.no_target")}
            </Text>
          </View>
          {target.workspacePath ? (
            <Text testID="models-target-workspace" style={styles.targetPath} numberOfLines={2}>
              {t("settings_models.workspace")}: {target.workspacePath}
            </Text>
          ) : null}
        </View>
      </SettingsGroup>

      <SettingsGroup title={t("settings_models.providers_heading")} testID="models-provider-list">
        <View style={styles.listActions}>
          <Text style={styles.listSummary}>
            {settings ? `${settings.profiles.length}` : ""}
          </Text>
          <Pressable
            testID="models-provider-refresh"
            accessibilityRole="button"
            accessibilityLabel={t("settings_models.refresh")}
            disabled={!target.ready || !supportsSettings || busy || loading || Boolean(recovery)}
            onPress={() => void refreshSettings()}
            style={({ pressed }) => [styles.smallAction, pressed && styles.pressed, (!target.ready || !supportsSettings || busy || loading || recovery) && styles.disabled]}
          >
            {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={15} color={colors.textMuted} />}
            <Text style={styles.smallActionText}>{loading ? t("settings_models.refreshing") : t("settings_models.refresh")}</Text>
          </Pressable>
        </View>
        {recovery ? (
          <View testID="models-provider-recovery" style={styles.warningBox}>
            <Text style={styles.warningText}>
              {t(recovery === "refresh" ? "settings_models.save_uncertain" : "settings_models.save_review_hint")}
            </Text>
            {recovery === "refresh" ? (
              <Pressable
                testID="models-provider-recovery-refresh"
                accessibilityRole="button"
                onPress={() => void refreshSettings()}
                disabled={!target.ready || !supportsSettings || busy || loading}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (!target.ready || !supportsSettings || busy || loading) && styles.disabled]}
              ><Text style={styles.secondaryButtonText}>{loading ? t("settings_models.refreshing") : t("settings_models.refresh")}</Text></Pressable>
            ) : (
              <Pressable
                testID="models-provider-recovery-reviewed"
                accessibilityRole="button"
                onPress={acknowledgeRecoveryReview}
                disabled={!target.ready || !settings || busy || loading}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (!target.ready || !settings || busy || loading) && styles.disabled]}
              ><Text style={styles.secondaryButtonText}>{t("settings_models.save_review_continue")}</Text></Pressable>
            )}
          </View>
        ) : null}
        {error && settings && !draft && !pendingDelete ? (
          <Text accessibilityRole="alert" testID="models-provider-error" style={styles.errorText}>{t(error)}</Text>
        ) : null}
        {!identity || !target.serverId ? (
          <View style={styles.emptyBody}>
            <Text style={styles.empty}>{t("settings_models.no_target")}</Text>
            {!target.profile && !target.loading ? (
              <Button
                testID="models-open-connections"
                variant="secondary"
                onPress={() => router.push("/settings-connections")}
              >
                {t("settings.manage_connections")}
              </Button>
            ) : null}
          </View>
        ) : showLoading ? (
          <View style={styles.loadingRow}><ActivityIndicator size="small" color={colors.textMuted} /><Text style={styles.secondary}>{t("settings_models.loading")}</Text></View>
        ) : error === "settings_models.unsupported" ? (
          <Text style={styles.empty}>{t("settings_models.unsupported")}</Text>
        ) : settings?.profiles.length ? settings.profiles.map((profile, index) => (
          <View key={`${profile.id}\0${profile.model}`} style={[styles.profileRow, index === settings.profiles.length - 1 && styles.lastRow]}>
            <Pressable
              testID={`models-provider-edit-${encodeURIComponent(profile.id)}-${encodeURIComponent(profile.model)}`}
              accessibilityRole="button"
              accessibilityLabel={`${t("settings_models.provider_name")}: ${profile.id}, ${t("settings_models.model")}: ${profile.model}${profile.isDefault ? `, ${t("settings_models.default")}` : ""}`}
              onPress={() => startEdit(profile)}
              disabled={busy || loading || !target.ready || Boolean(recovery)}
              style={({ pressed }) => [styles.profilePressable, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
            >
              <View style={styles.profileCopy}>
                <View style={styles.profileTitleRow}>
                  <Text style={styles.profileName} numberOfLines={1}>{profile.id}</Text>
                  {profile.isDefault ? <Text style={styles.defaultBadge}>{t("settings_models.default")}</Text> : null}
                </View>
                <Text style={styles.profileModel} numberOfLines={1}>{profile.model}</Text>
                <Text style={styles.profileEndpoint} numberOfLines={1}>{safeProviderEndpointLabel(profile.endpoint)}</Text>
              </View>
            </Pressable>
            {supportsMultipleModels && settings.supportsMultipleModels ? (
              <Pressable
                testID={`models-provider-add-model-${encodeURIComponent(profile.id)}`}
                accessibilityRole="button"
                accessibilityLabel={t("settings_models.add_model")}
                onPress={() => startEdit(profile, true)}
                disabled={busy || loading || !target.ready || Boolean(recovery)}
                style={({ pressed }) => [styles.iconAction, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
              ><Plus size={17} color={colors.textMuted} /></Pressable>
            ) : null}
            {supportsDeletion && profile.canDelete ? (
              <Pressable
                testID={`models-provider-delete-${encodeURIComponent(profile.id)}-${encodeURIComponent(profile.model)}`}
                accessibilityRole="button"
                accessibilityLabel={`${t("settings_models.delete")} ${profile.id} ${profile.model}`}
                onPress={() => openDelete(profile)}
                disabled={busy || loading || !target.ready || Boolean(recovery)}
                style={({ pressed }) => [styles.iconAction, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
              ><Trash2 size={17} color={colors.red} /></Pressable>
            ) : null}
          </View>
        )) : settings ? (
          <View style={styles.emptyBody}>
            <Text style={styles.empty}>{t("settings_models.empty")}</Text>
            <Text style={styles.secondary}>{t("settings_models.empty_hint")}</Text>
          </View>
        ) : error ? (
          <Text style={styles.errorText}>{t(error)}</Text>
        ) : null}
        {identity && target.ready && supportsSettings ? (
          <Pressable
            testID="models-provider-new"
            accessibilityRole="button"
            onPress={startNewProvider}
            disabled={busy || loading || !settings || !target.ready || Boolean(recovery)}
            style={({ pressed }) => [styles.addAction, pressed && styles.pressed, (busy || loading || !settings || !target.ready || recovery) && styles.disabled]}
          ><Plus size={17} color={colors.text} /><Text style={styles.addActionText}>{t("settings_models.add_provider")}</Text></Pressable>
        ) : null}
      </SettingsGroup>

      {settings && !canUseIndependentProbe ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>{t("settings_models.unsupported_test")}</Text>
        </View>
      ) : null}
      {settings?.restartRequired ? (
        <View testID="models-provider-restart-required" style={styles.warningBox}>
          <Text style={styles.warningText}>{t("settings_models.restart_required")}</Text>
        </View>
      ) : null}
      {settings?.warning ? (
        <View style={styles.warningBox}>
            <Text style={styles.warningText}>{t("settings_models.delete_warning")}</Text>
        </View>
      ) : null}

      {draft ? (
        <SettingsGroup title={draftEntry?.mode === "edit" ? t("settings_models.model") : t("settings_models.add_provider")} testID="models-provider-form">
          {draftEntry?.mode === "new-provider" && templates.length ? (
            <View style={styles.templateBlock}>
              <Text style={styles.fieldLabel}>{t("settings_models.templates")}</Text>
              <View style={styles.chips}>
                {templates.map(template => (
                  <Pressable
                    key={template.id}
                    testID={`models-provider-template-${encodeURIComponent(template.id)}`}
                    accessibilityRole="button"
                    onPress={() => startFromTemplate(template)}
                    disabled={busy || loading || !target.ready || Boolean(recovery)}
                    style={({ pressed }) => [styles.templateChip, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
                  ><Text style={styles.chipText}>{template.displayName}</Text></Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {draftEntry?.mode !== "new-model" ? renderField(t("settings_models.provider_name"), draft.id, value => updateDraft("id", value), "models-provider-id", { placeholder: "custom-provider" }) : (
            <View style={styles.fixedField}><Text style={styles.fieldLabel}>{t("settings_models.provider_name")}</Text><Text style={styles.fixedValue}>{draft.id}</Text></View>
          )}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("settings_models.api_format")}</Text>
            <View style={styles.chips}>
              {PROVIDER_API_FORMATS.map(format => (
                <Pressable
                  key={format}
                  testID={`models-provider-format-${format}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: draft.apiFormat === format }}
                  onPress={() => updateDraft("apiFormat", format)}
                  disabled={draftEntry?.mode === "new-model" || busy || loading || !target.ready || Boolean(recovery)}
                  style={({ pressed }) => [styles.formatChip, draft.apiFormat === format && styles.selectedChip, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
                ><Text style={[styles.formatText, draft.apiFormat === format && styles.selectedChipText]}>{format}</Text></Pressable>
              ))}
            </View>
          </View>
          {renderField(t("settings_models.endpoint"), draft.endpoint, value => updateDraft("endpoint", value), "models-provider-endpoint", { placeholder: "https://api.example.com/v1" })}
          {renderField(t("settings_models.model"), draft.model, value => updateDraft("model", value), "models-provider-model", { placeholder: "model-name" })}
          <View style={styles.numberFields}>
            <View style={styles.numberField}>{renderField(t("settings_models.context_window"), draft.contextWindowTokens, value => updateDraft("contextWindowTokens", value), "models-provider-context-window", { keyboard: "numeric" })}</View>
            <View style={styles.numberField}>{renderField(t("settings_models.max_output"), draft.maxOutputTokens, value => updateDraft("maxOutputTokens", value), "models-provider-max-output", { keyboard: "numeric" })}</View>
          </View>
          <Text style={styles.fieldHint}>{t("settings_models.limits_help")}</Text>
          {supportsAuthenticationPolicy ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t("settings_models.authentication")}</Text>
              <View style={styles.chips}>
                {(["api_key", "none"] as const).map(mode => (
                  <Pressable
                    key={mode}
                    testID={`models-provider-auth-${mode}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: draft.authentication === mode }}
                    onPress={() => updateDraft("authentication", mode)}
                    disabled={busy || loading || !target.ready || Boolean(recovery)}
                    style={({ pressed }) => [styles.formatChip, draft.authentication === mode && styles.selectedChip, pressed && styles.pressed, (busy || loading || !target.ready || recovery) && styles.disabled]}
                  ><Text style={[styles.chipText, draft.authentication === mode && styles.selectedChipText]}>{t(mode === "api_key" ? "settings_models.auth_api_key" : "settings_models.auth_none")}</Text></Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {draft.authentication === "api_key" ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t("settings_models.api_key")}</Text>
              <TextInput
                testID="models-provider-api-key"
                accessibilityLabel={t("settings_models.api_key")}
                value={draft.apiKey}
                onChangeText={value => updateDraft("apiKey", value)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={draft.savedCredentialConfigured ? "••••••••" : ""}
                placeholderTextColor={colors.textDim}
                selectionColor={colors.blue}
                style={styles.input}
                textContentType="password"
                editable={!busy && !loading && !recovery && target.ready}
              />
              <Text style={styles.fieldHint}>{t(draft.savedCredentialConfigured ? "settings_models.api_key_configured" : "settings_models.api_key_not_configured")}</Text>
            </View>
          ) : null}
          {supportsModelCapabilities && settings?.supportsModelCapabilities && draft.capabilities ? (
            <View style={styles.field}>
              <Pressable
                testID="models-provider-capabilities-toggle"
                accessibilityRole="button"
                accessibilityLabel={t("settings_models.capabilities_optional")}
                accessibilityState={{ expanded: capabilitiesExpanded }}
                aria-expanded={capabilitiesExpanded}
                onPress={() => setCapabilitiesExpanded(current => !current)}
                disabled={busy || loading || !target.ready || Boolean(recovery)}
                style={({ pressed }) => [styles.capabilityDisclosure, pressed && styles.pressed, (busy || loading || !target.ready || recovery) && styles.disabled]}
              >
                <Text style={styles.fieldLabel}>{t("settings_models.capabilities_optional")}</Text>
                {capabilitiesExpanded
                  ? <ChevronUp size={17} color={colors.textMuted} />
                  : <ChevronDown size={17} color={colors.textMuted} />}
              </Pressable>
              {capabilitiesExpanded ? (
                <View style={styles.chips}>
                  {([
                    ["tools", "settings_models.capability_tools"],
                    ["vision", "settings_models.capability_vision"],
                    ["reasoning", "settings_models.capability_reasoning"],
                    ["structured_output", "settings_models.capability_structured_output"],
                  ] as const).map(([key, labelKey]) => {
                    const checked = draft.capabilities?.[key] === true;
                    return (
                      <Pressable
                        key={key}
                        testID={`models-provider-capability-${key}`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        onPress={() => updateDraft("capabilities", { ...draft.capabilities!, [key]: !checked })}
                        disabled={busy || loading || !target.ready || Boolean(recovery)}
                        style={({ pressed }) => [styles.capabilityChip, checked && styles.selectedChip, pressed && styles.pressed, (busy || loading || !target.ready || recovery) && styles.disabled]}
                      >{checked ? <Check size={14} color={colors.text} /> : null}<Text style={[styles.chipText, checked && styles.selectedChipText]}>{t(labelKey)}</Text></Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}
          <Pressable
            testID="models-provider-default"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: draft.makeDefault }}
            onPress={() => updateDraft("makeDefault", !draft.makeDefault)}
            disabled={busy || loading || !target.ready || Boolean(recovery)}
            style={({ pressed }) => [styles.checkboxRow, pressed && styles.pressed, (busy || loading || !target.ready || recovery) && styles.disabled]}
          >
            <View style={[styles.checkbox, draft.makeDefault && styles.checkboxChecked]}>{draft.makeDefault ? <Check size={14} color={colors.accentText} /> : null}</View>
            <Text style={styles.checkboxLabel}>{t("settings_models.make_default")}</Text>
          </Pressable>
          {supportsSave && !canUseIndependentProbe ? (
            <Text style={styles.fieldHint}>{t("settings_models.save_tests_connection")}</Text>
          ) : null}
          {error ? <Text accessibilityRole="alert" testID="models-provider-error" style={styles.errorText}>{t(error)}</Text> : null}
          {notice ? <Text testID="models-provider-notice" style={styles.noticeText}>{t(notice)}</Text> : null}
          {outcome ? (
            <Text testID="models-provider-test-result" style={outcome === "settings_models.test_success" ? styles.noticeText : styles.errorText}>
              {outcome.startsWith("settings_models.test_failed:")
                ? t("settings_models.test_failed", { reason: t(`settings_models.error_${outcome.split(":")[1]}`) })
                : t(outcome)}
            </Text>
          ) : null}
          <View style={styles.formActions}>
            {canUseIndependentProbe ? (
              <Pressable
                testID="models-provider-test"
                accessibilityRole="button"
                onPress={() => void testConnection()}
                disabled={!canTestCurrentDraft || busy || loading || !target.ready || Boolean(recovery)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (!canTestCurrentDraft || busy || loading || recovery) && styles.disabled]}
              ><Text style={styles.secondaryButtonText}>{busy && canTestCurrentDraft ? t("settings_models.testing") : t("settings_models.test_connection")}</Text></Pressable>
            ) : null}
            <Pressable
              testID="models-provider-save"
              accessibilityRole="button"
              onPress={onSave}
              disabled={busy || loading || !settings || !supportsSave || !target.ready || Boolean(recovery)}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (busy || loading || !settings || !supportsSave || !target.ready || recovery) && styles.disabled]}
            >{busy ? <LoaderCircle size={16} color={colors.accentText} /> : null}<Text style={styles.primaryButtonText}>{busy ? t("settings_models.saving") : t(canUseIndependentProbe ? "settings_models.save" : "settings_models.save_and_test")}</Text></Pressable>
            <Pressable
              testID="models-provider-close"
              accessibilityRole="button"
              accessibilityLabel={t("settings_models.dismiss")}
              onPress={() => { draftRevision.current += 1; setDraftState(null); setCapabilitiesExpanded(false); setError(null); setNotice(null); setTestState(null); }}
              disabled={busy || loading || !target.ready || Boolean(recovery)}
              style={({ pressed }) => [styles.iconAction, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
            ><ChevronDown size={19} color={colors.textMuted} /></Pressable>
          </View>
        </SettingsGroup>
      ) : null}

      {pendingDelete ? (
        <SettingsGroup title={t(pendingDelete.kind === "model" ? "settings_models.delete_model_title" : "settings_models.delete_title")} testID="models-provider-delete-confirmation">
          <View style={styles.deleteBody}>
            <Text style={styles.bodyText}>
              {pendingDelete.kind === "model"
                ? t("settings_models.delete_model_message", { target: targetContext, model: pendingDelete.profile.model })
                : t("settings_models.delete_message", { target: targetContext })}
            </Text>
            {pendingDelete.kind === "provider" && pendingDelete.profile.isDefault ? (
              <Text style={styles.fieldLabel}>{t("settings_models.replacement_provider")}</Text>
            ) : pendingDelete.kind === "model" && (pendingDelete.profile.isDefault || pendingDelete.profile.isProviderDefault) ? (
              <Text style={styles.fieldLabel}>{t("settings_models.replacement_model")}</Text>
            ) : null}
            {needsDeleteReplacement ? (
              replacementOptions.length ? (
                <View style={styles.chips}>
                  {replacementOptions.map(option => (
                    <Pressable
                      key={option}
                      testID={`models-provider-delete-replacement-${encodeURIComponent(option)}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: pendingDelete.replacement === option }}
                  onPress={() => setDeleteState({ ...pendingDelete, replacement: option })}
                  disabled={busy || loading || !target.ready || Boolean(recovery)}
                  style={({ pressed }) => [styles.formatChip, pendingDelete.replacement === option && styles.selectedChip, pressed && styles.pressed, (busy || loading || !target.ready || recovery) && styles.disabled]}
                    ><Text style={[styles.chipText, pendingDelete.replacement === option && styles.selectedChipText]}>{option}</Text></Pressable>
                  ))}
                </View>
              ) : <Text style={styles.errorText}>{t("settings_models.replacement_required")}</Text>
            ) : null}
            {pendingDelete.kind === "model" && settings?.profiles.filter(profile => profile.id === pendingDelete.profile.id).length === 1 ? (
              <Text style={styles.fieldHint}>{t("settings_models.delete_last_model")}</Text>
            ) : null}
            {error ? <Text accessibilityRole="alert" testID="models-provider-error" style={styles.errorText}>{t(error)}</Text> : null}
            <View style={styles.formActions}>
              <Pressable
                testID="models-provider-delete-cancel"
                accessibilityRole="button"
                onPress={() => { setDeleteState(null); setError(null); }}
                disabled={busy || loading || !target.ready || Boolean(recovery)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (loading || recovery) && styles.disabled]}
              ><Text style={styles.secondaryButtonText}>{t("settings_models.cancel")}</Text></Pressable>
              <Pressable
                testID="models-provider-delete-confirm"
                accessibilityRole="button"
                onPress={() => void confirmDelete()}
                disabled={busy || loading || !target.ready || Boolean(recovery) || !canConfirmDelete || (pendingDelete.kind === "model" && settings?.profiles.filter(profile => profile.id === pendingDelete.profile.id).length === 1)}
                style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed, (busy || loading || !target.ready || recovery || !canConfirmDelete) && styles.disabled]}
              >{busy ? <LoaderCircle size={16} color={colors.text} /> : <Trash2 size={16} color={colors.red} />}<Text style={styles.deleteButtonText}>{t(pendingDelete.kind === "model" ? "settings_models.delete" : "settings_models.delete_confirm")}</Text></Pressable>
            </View>
          </View>
        </SettingsGroup>
      ) : null}
    </View>
  );
}

function safeErrorCategory(value: unknown): string {
  const allowed = new Set(["authentication", "permission", "quota", "rate_limit", "overloaded", "model", "timeout", "network", "response", "configuration", "changed", "busy", "unsupported"]);
  return typeof value === "string" && allowed.has(value) ? value : "configuration";
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { gap: spacing.md },
  targetBody: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  targetHeading: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  targetName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "500" },
  targetPath: { color: colors.textDim, fontSize: 12, lineHeight: 17, paddingLeft: 26 },
  listActions: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  listSummary: { color: colors.textDim, fontSize: 12 },
  smallAction: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  smallActionText: { color: colors.textMuted, fontSize: 13 },
  iconAction: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  loadingRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  secondary: { color: colors.textMuted, fontSize: 13 },
  emptyBody: { padding: spacing.lg, gap: spacing.xs },
  empty: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  profileRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingRight: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lastRow: { borderBottomWidth: 0 },
  profilePressable: { flex: 1, minWidth: 0, minHeight: 72, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  profileCopy: { flex: 1, minWidth: 0, gap: 3 },
  profileTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  profileName: { flexShrink: 1, color: colors.text, fontSize: 14, fontWeight: "500" },
  defaultBadge: { color: colors.blue, fontSize: 11, fontWeight: "500" },
  profileModel: { color: colors.textMuted, fontSize: 13 },
  profileEndpoint: { color: colors.textDim, fontSize: 11 },
  addAction: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  addActionText: { color: colors.text, fontSize: 14, fontWeight: "500" },
  templateBlock: { padding: spacing.lg, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  field: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
  fieldLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  capabilityDisclosure: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.xs },
  fieldHint: { color: colors.textDim, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, color: colors.text, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 14 },
  multilineInput: { minHeight: 88, textAlignVertical: "top" },
  fixedField: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
  fixedValue: { color: colors.text, fontSize: 14 },
  numberFields: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  numberField: { flex: 1, minWidth: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  templateChip: { minHeight: 36, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  formatChip: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  capabilityChip: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  chipText: { color: colors.textMuted, fontSize: 12 },
  formatText: { color: colors.textMuted, fontSize: 11 },
  selectedChip: { borderColor: colors.blue, backgroundColor: colors.surfaceRaised },
  selectedChipText: { color: colors.text, fontWeight: "500" },
  checkboxRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  checkbox: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.sm },
  checkboxChecked: { backgroundColor: colors.blue, borderColor: colors.blue },
  checkboxLabel: { flex: 1, color: colors.text, fontSize: 13 },
  formActions: { minHeight: 60, flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: spacing.sm, padding: spacing.md },
  primaryButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.accent },
  primaryButtonText: { color: colors.accentText, fontSize: 14, fontWeight: "500" },
  secondaryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.lg },
  secondaryButtonText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  deleteButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.red, borderRadius: radius.lg },
  deleteButtonText: { color: colors.red, fontSize: 13, fontWeight: "500" },
  deleteBody: { padding: spacing.lg, gap: spacing.md },
  bodyText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  warningBox: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  warningText: { color: colors.yellow, fontSize: 13, lineHeight: 19 },
  errorText: { color: colors.red, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg },
  noticeText: { color: colors.green, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});

export default ModelServicesSettings;

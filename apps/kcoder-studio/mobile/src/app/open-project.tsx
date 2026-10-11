import { markWorkspaceOpenDelivery, loadWorkspaceOpenDelivery } from "@/storage/pending-workspace-operation-v2";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { acknowledgeConfirmedWorkspaceOperation, type WorkspaceOperationReceiptHandle } from "@/storage/pending-workspace-operation";
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useFormOwner, useFormState } from "@/features/forms/form-owner";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Archive,
  ChevronLeft,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Github,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Field } from "@/components/ui";
import {
  listWorkspaceOptions,
  listManagedWorktrees,
  openWorkspaceWithReceipt,
  prepareManagedWorktreeWithReceipt,
  previewManagedWorktreeArchive,
  archiveManagedWorktree,
  restoreManagedWorktree,
  forgetManagedWorktree,
  type ManagedWorktree,
  type ManagedWorktreeArchivePreview,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

type OpenMode = "open" | "create" | "worktree" | "github";

export default function OpenProjectRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { profileId } = useLocalSearchParams<{ profileId?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [compact, setCompact] = useState(false);
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, demo } =
    useApp();
  const profileReady =
    hydrated && (!profileId || activeProfile?.id === profileId);
  const invalidProfile =
    hydrated &&
    Boolean(profileId) &&
    !profiles.some((profile) => profile.id === profileId);
  const [serverId, setSelectedServerId] = useState("");
  const server = useMemo(
    () => runtime.servers.find((item) => item.id === serverId),
    [runtime.servers, serverId],
  );
  const selectedTargetKey = activeProfile && server ? threadListScopeKey(activeProfile, server) : null;
  const gatewayScope = activeProfile ? [activeProfile.id, activeProfile.baseUrl, activeProfile.authorizationGeneration, activeProfile.deviceId] : null;
  const owner = useFormOwner(JSON.stringify([profileId, profileReady, gatewayScope, selectedTargetKey, demo]));
  const setServerId = (update: SetStateAction<string>) => {
    if (!owner.isCurrent()) return;
    setSelectedServerId((current) => {
      if (!owner.isCurrent()) return current;
      return typeof update === "function" ? update(current) : update;
    });
  };
  const goBack = () => {
    if (owner.isCurrent()) backOrReplace(router, profileHomeHref(profileId ?? activeProfile?.id));
  };
  const [path, setPath] = useFormState(owner, "");
  const [mode, setMode] = useFormState<OpenMode>(owner, "open");
  const [gitRef, setGitRef] = useFormState(owner, "");
  const [workspaceOptions, setWorkspaceOptions] = useFormState<WorkspaceOption[]>(owner,
    [],
  );
  const [managedWorktrees, setManagedWorktrees] = useFormState<ManagedWorktree[]>(owner,
    [],
  );
  const [busyWorktreePath, setBusyWorktreePath] = useFormState<string | null>(owner, null);
  const [pendingArchive, setPendingArchive] =
    useFormState<ManagedWorktreeArchivePreview | null>(owner, null);
  const [pendingForget, setPendingForget] = useFormState<ManagedWorktree | null>(owner,
    null,
  );
  const [pendingTargetKey, setPendingTargetKey] = useFormState<string | null>(owner, null);
  const [forgetName, setForgetName] = useFormState(owner, "");
  const [optionsLoading, setOptionsLoading] = useFormState(owner, false);
  const [loading, setLoading] = useFormState(owner, false);
  const [error, setError] = useFormState<string | null>(owner, null);
  const [pendingOpened, setPendingOpened] = useFormState<{ receipt: WorkspaceOperationReceiptHandle; profile: GatewayProfile; server: KCoderServer; params: Record<string, string> } | null>(owner, null);
  const openedContinuation = useRef<{ owner: typeof owner; value: NonNullable<typeof pendingOpened>; busy: boolean; navigated: boolean } | null>(null);
  if (openedContinuation.current?.owner !== owner) openedContinuation.current = null;
  const continueOpened = async (entry: NonNullable<typeof openedContinuation.current>) => {
    if (!owner.isCurrent() || entry.owner !== owner || entry.busy || entry.navigated) return;
    entry.busy = true; setLoading(true);
    try {
      const outcome = await acknowledgeConfirmedWorkspaceOperation(entry.value.receipt, { profile: entry.value.profile, server: entry.value.server });
      if (!owner.isCurrent() || openedContinuation.current !== entry) return;
      if (outcome === "unverified" || outcome === "superseded") {
        setError(t("open_project.ready_identity_unverified")); return;
      }
      entry.navigated = true; setPendingOpened(null);
      router.replace({ pathname: "/new", params: { ...entry.value.params,
        operationReceiptId: entry.value.receipt.id, operationReceiptVersion: "2", ...(outcome !== "consumed" ? { workspaceBookkeeping: "pending" } : {}) } });
    } finally { entry.busy = false; setLoading(false); }
  };

  const [deliveryChecking, setDeliveryChecking] = useFormState(owner, false);
  const [deliveryError, setDeliveryError] = useFormState<string | null>(owner, null);
  const [deliveryRevision, setDeliveryRevision] = useFormState(owner, 0);
  useEffect(() => {
    if (demo || !owner.isCurrent() || !profileReady || !activeProfile || !server || !path.trim() || mode === "github") return;
    let cancelled = false; setDeliveryChecking(true); setDeliveryError(null);
    const kind = mode === "worktree" ? "worktree" : mode === "create" ? "create" : "open";
    void loadWorkspaceOpenDelivery(activeProfile, server, kind, path.trim()).then(confirmed => {
      if (cancelled || !owner.isCurrent()) return;
      if (!confirmed) { setPendingOpened(null); openedContinuation.current = null; return; }
      const value = { receipt: confirmed.receipt, profile: { ...activeProfile }, server: { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) }, params: { profileId: activeProfile.id, serverId: server.id, cwd: confirmed.path, operationKind: kind, operationSourcePath: path.trim() } };
      openedContinuation.current = { owner, value, busy: false, navigated: false }; setPendingOpened(value);
    }).catch(value => { if (!cancelled && owner.isCurrent()) setDeliveryError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (!cancelled && owner.isCurrent()) setDeliveryChecking(false); });
    return () => { cancelled = true; };
  }, [owner, demo, profileReady, server, path, mode, deliveryRevision]);

  const [optionsReady, setOptionsReady] = useFormState(owner, false);
  const [catalogRevision, setCatalogRevision] = useFormState(owner, 0);
  const retryCatalogs = () => {
    if (!owner.isCurrent()) return;
    setOptionsReady(false);
    setError(null);
    setCatalogRevision((value) => value + 1);
  };
  const serverSignature = runtime.servers.map((item) => item.id).join("\0");

  useEffect(() => {
    const update = ({ window }: { window: { height: number } }) =>
      setCompact(window.height < 700);
    update({ window: Dimensions.get("window") });
    const subscription = Dimensions.addEventListener("change", update);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (
      owner.isCurrent() && shouldActivateRouteProfile({
        focused: isFocused,
        hydrated,
        routeProfileId: profileId,
        activeProfileId: activeProfile?.id,
        profileIds: profiles.map((profile) => profile.id),
      })
    ) {
      void setActiveProfile(profileId!);
    }
  }, [
    activeProfile?.id,
    hydrated,
    isFocused,
    profileId,
    profiles,
    setActiveProfile,
  ]);

  useEffect(() => {
    if (!owner.isCurrent()) return;
    setServerId("");
    setPath("");
    setWorkspaceOptions([]);
    setManagedWorktrees([]);
    setGitRef("");
    setError(null);
  }, [profileId]);

  useEffect(() => {
    setPendingArchive(null);
    setPendingForget(null);
    setPendingTargetKey(null);
    setForgetName("");
  }, [owner]);

  useEffect(() => {
    if (!owner.isCurrent() || !profileReady || runtime.loading) return;
    setServerId((current) => {
      if (current && runtime.servers.some((item) => item.id === current))
        return current;
      const next = runtime.servers[0];
      setPath(next?.workspacePath ?? "");
      return next?.id ?? "";
    });
  }, [activeProfile?.id, profileReady, runtime.loading, serverSignature]);

  useEffect(() => {
    if (!profileReady || runtime.loading || !activeProfile || !server) {
      setWorkspaceOptions([]);
      return;
    }
    if (demo) {
      setWorkspaceOptions([
        {
          path: server.workspacePath ?? "/data/projects/kcoder",
          label: "KCoder",
          kind: "workspace",
        },
      ]);
      setPath(server.workspacePath ?? "/data/projects/kcoder");
      setOptionsReady(true);
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    setOptionsReady(false);
    void Promise.all([
      listWorkspaceOptions(activeProfile, server),
      listManagedWorktrees(activeProfile, server),
    ])
      .then(([items, worktrees]) => {
        if (!cancelled && owner.isCurrent()) {
          setWorkspaceOptions(items);
          setManagedWorktrees(worktrees);
          setPath((current) => current || server.workspacePath || "");
          setOptionsReady(true);
        }
      })
      .catch((value) => {
        if (!cancelled && owner.isCurrent())
          setError(value instanceof Error ? value.message : String(value));
      })
      .finally(() => {
        if (!cancelled && owner.isCurrent()) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, demo, profileReady, runtime.loading, catalogRevision]);

  const selectServer = (nextServerId: string) => {
    if (!owner.isCurrent()) return;
    const next = runtime.servers.find((item) => item.id === nextServerId);
    setServerId(nextServerId);
    setPath(next?.workspacePath ?? "");
    setWorkspaceOptions([]);
    setManagedWorktrees([]);
    setError(null);
  };

  const refreshManagedWorktrees = async () => {
    if (!owner.isCurrent() || !activeProfile || !server || demo) return;
    const [options, worktrees] = await Promise.all([
      listWorkspaceOptions(activeProfile, server),
      listManagedWorktrees(activeProfile, server),
    ]);
    if (!owner.isCurrent()) return;
    setWorkspaceOptions(options);
    setManagedWorktrees(worktrees);
  };

  const requestArchive = async (worktree: ManagedWorktree) => {
    if (!owner.isCurrent() || !optionsReady || !profileReady || runtime.loading || !activeProfile || !server || busyWorktreePath) return;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      const preview = await previewManagedWorktreeArchive(
        activeProfile,
        server,
        worktree.path,
      );
      if (!owner.isCurrent()) return;
      if (!preview.archiveAllowed) {
        throw new Error(
          preview.blockingReasons.join(t("open_project.reason_separator")) || t("open_project.worktree_not_safe_to_archive"),
        );
      }
      setPendingArchive(preview);
      setPendingTargetKey(selectedTargetKey);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const confirmArchive = async () => {
    if (
      !owner.isCurrent() ||
      !optionsReady ||
      !profileReady || runtime.loading ||
      !activeProfile ||
      !server ||
      !pendingArchive ||
      busyWorktreePath ||
      pendingTargetKey !== selectedTargetKey
    )
      return;
    const preview = pendingArchive;
    setBusyWorktreePath(preview.path);
    setError(null);
    try {
      await archiveManagedWorktree(activeProfile, server, preview, true);
      if (!owner.isCurrent()) return;
      setPendingArchive(null);
      setPendingTargetKey(null);
      await refreshManagedWorktrees();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const restoreWorktree = async (worktree: ManagedWorktree) => {
    if (!owner.isCurrent() || !optionsReady || !profileReady || runtime.loading || !activeProfile || !server || busyWorktreePath) return;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      await restoreManagedWorktree(activeProfile, server, worktree);
      if (!owner.isCurrent()) return;
      await refreshManagedWorktrees();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const requestForget = (worktree: ManagedWorktree) => {
    if (!owner.isCurrent() || !optionsReady || !profileReady || runtime.loading || !activeProfile || !server) return;
    if (worktree.conversations.length > 0) {
      setError(t("open_project.worktree_has_sessions"));
      return;
    }
    setPendingForget(worktree);
    setPendingTargetKey(selectedTargetKey);
    setForgetName("");
    setError(null);
  };

  const confirmForget = async () => {
    if (
      !owner.isCurrent() ||
      !optionsReady ||
      !profileReady || runtime.loading ||
      !activeProfile ||
      !server ||
      !pendingForget ||
      busyWorktreePath ||
      pendingTargetKey !== selectedTargetKey
    )
      return;
    const worktree = pendingForget;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      await forgetManagedWorktree(activeProfile, server, worktree);
      if (!owner.isCurrent()) return;
      setPendingForget(null);
      setPendingTargetKey(null);
      setForgetName("");
      await refreshManagedWorktrees();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const submit = async () => {
    if (
      !owner.isCurrent() || openedContinuation.current?.owner === owner || deliveryChecking || deliveryError || loading || !optionsReady ||
      mode === "github" ||
      !profileReady ||
      runtime.loading ||
      !activeProfile ||
      !server ||
      !path.trim()
    )
      return;
    setLoading(true);
    setError(null);
    try {
      const confirmed = demo
        ? { path: path.trim(), receipt: undefined }
        : mode === "worktree"
          ? await prepareManagedWorktreeWithReceipt(
              activeProfile,
              server,
              path.trim(),
              gitRef,
            )
          : await openWorkspaceWithReceipt(
              activeProfile,
              server,
              path.trim(),
              mode === "create",
            );
      if (!owner.isCurrent()) return;
      if (confirmed.receipt?.version === 2) {
        await markWorkspaceOpenDelivery(activeProfile, server, confirmed.receipt);
        if (!owner.isCurrent()) return;
        const value = { receipt: confirmed.receipt, profile: { ...activeProfile }, server: { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) },
          params: { profileId: activeProfile.id, serverId: server.id, cwd: confirmed.path, operationKind: mode === "worktree" ? "worktree" : mode === "create" ? "create" : "open", operationSourcePath: path.trim() } };
        const entry = { owner, value, busy: false, navigated: false };
        openedContinuation.current = entry; setPendingOpened(value);
        await continueOpened(entry);
      } else {
        const bookkeeping = confirmed.receipt ? await acknowledgeConfirmedWorkspaceOperation(confirmed.receipt) : "consumed";
        if (!owner.isCurrent()) return;
        router.replace({ pathname: "/new", params: { profileId: activeProfile.id, serverId: server.id, cwd: confirmed.path,
          ...(confirmed.receipt && bookkeeping !== "consumed" ? { workspaceBookkeeping: "pending", operationReceiptId: confirmed.receipt.id, operationKind: mode === "worktree" ? "worktree" : mode === "create" ? "create" : "open", operationSourcePath: path.trim() } : {}) } });
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };

  const unavailable = !profileReady || runtime.loading;

  if (invalidProfile) {
    return (
      <View
        testID="open-project-route"
        style={[styles.root, { paddingTop: insets.top }]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={t("task.back")}
            onPress={goBack}
            style={styles.headerButton}
          >
            <ChevronLeft size={23} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>{t("task.add_project")}</Text>
          <View style={styles.headerButton} />
        </View>
        <EmptyState
          icon={<FolderOpen size={42} color={colors.textDim} />}
          title={t("home.deleted_gateway_title")}
          body={t("open_project.removed_gateway_body")}
        />
      </View>
    );
  }

  return (
    <View
      testID="open-project-route"
      style={[styles.root, { paddingTop: insets.top }]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("task.back")}
          onPress={goBack}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("task.add_project")}</Text>
        <View style={styles.headerButton} />
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.xl },
        ]}
      >
        <View style={[styles.hero, compact && styles.heroCompact]}>
          <FolderOpen size={compact ? 26 : 44} color={colors.green} />
          <Text style={styles.title}>{t("open_project.open_remote_directory")}</Text>
          {!compact ? (
            <Text style={styles.body}>
              {t("open_project.choose_server_and_project")}
            </Text>
          ) : null}
        </View>

        {unavailable ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.textMuted} />
            <Text style={styles.loadingText}>{t("open_project.switching_gateway")}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>{t("open_project.server")}</Text>
        {runtime.servers.map((item) => (
          <Pressable
            key={item.id}
            disabled={unavailable}
            onPress={() => selectServer(item.id)}
            style={[styles.server, item.id === serverId && styles.selected]}
          >
            <Text style={styles.serverText}>{item.label}</Text>
            <Text style={styles.serverMeta}>
              {item.transport.toUpperCase()}
            </Text>
          </Pressable>
        ))}

        <View style={styles.optionsHeader}>
          <Text style={styles.label}>{t("open_project.registered_projects")}</Text>
          {optionsLoading ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : null}
        </View>
        {workspaceOptions.length > 0 ? (
          <View style={styles.options}>
            {workspaceOptions.map((item) => (
              <Pressable
                key={`${item.kind}:${item.path}`}
                disabled={unavailable || optionsLoading}
                onPress={() => {
                  setMode("open");
                  setPath(item.path);
                }}
                style={[
                  styles.option,
                  path === item.path && mode === "open" && styles.selected,
                ]}
              >
                {item.kind === "worktree" ? (
                  <FolderGit2 size={18} color={colors.blue} />
                ) : (
                  <FolderOpen size={18} color={colors.textMuted} />
                )}
                <View style={styles.optionCopy}>
                  <Text style={styles.optionTitle}>{item.label}</Text>
                  <Text style={styles.optionPath} numberOfLines={1}>
                    {item.path}
                  </Text>
                </View>
                <Text style={styles.optionKind}>
                  {item.kind === "worktree" ? "WORKTREE" : "WORKSPACE"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : !optionsLoading && server ? (
          <Text style={styles.emptyOptions}>
            {t("open_project.no_registered_projects")}
          </Text>
        ) : null}

        {managedWorktrees.length > 0 ? (
          <View
            testID="managed-worktrees-section"
            style={styles.managedSection}
          >
            <Text style={styles.label}>{t("open_project.managed_worktrees")}</Text>
            <Text style={styles.managedHelp}>
              {t("open_project.managed_worktrees_description")}
            </Text>
            {managedWorktrees.map((worktree) => {
              const busy = busyWorktreePath === worktree.path;
              return (
                <View
                  key={worktree.path}
                  testID={`managed-worktree-${worktree.worktreeId}`}
                  style={styles.managedCard}
                >
                  <View style={styles.managedHeading}>
                    <View style={styles.optionCopy}>
                      <Text style={styles.optionTitle}>
                        {worktree.repositoryName}
                      </Text>
                      <Text style={styles.optionPath} numberOfLines={1}>
                        {worktree.path}
                      </Text>
                    </View>
                    <Text style={styles.optionKind}>
                      {worktree.state.toUpperCase()}
                    </Text>
                  </View>
                  {worktree.lastError ? (
                    <Text style={styles.managedError}>
                      {worktree.lastError}
                    </Text>
                  ) : null}
                  <View style={styles.managedActions}>
                    {worktree.state === "active" ? (
                      <Pressable
                        testID={`archive-worktree-${worktree.worktreeId}`}
                        disabled={busy}
                        onPress={() => void requestArchive(worktree)}
                        style={styles.managedButton}
                      >
                        <Archive size={16} color={colors.textMuted} />
                        <Text style={styles.managedButtonText}>
                          {busy ? t("open_project.preflighting") : t("open_project.archive")}
                        </Text>
                      </Pressable>
                    ) : null}
                    {worktree.state === "restorable" ? (
                      <Pressable
                        testID={`restore-worktree-${worktree.worktreeId}`}
                        disabled={busy}
                        onPress={() => void restoreWorktree(worktree)}
                        style={styles.managedButton}
                      >
                        <RotateCcw size={16} color={colors.textMuted} />
                        <Text style={styles.managedButtonText}>
                          {busy ? t("open_project.restoring") : t("task.restore_task")}
                        </Text>
                      </Pressable>
                    ) : null}
                    {worktree.state !== "active" ? (
                      <Pressable
                        testID={`forget-worktree-${worktree.worktreeId}`}
                        disabled={busy || worktree.conversations.length > 0}
                        onPress={() => requestForget(worktree)}
                        style={[styles.managedButton, styles.dangerButton]}
                      >
                        <Trash2 size={16} color={colors.red} />
                        <Text style={styles.dangerText}>{t("open_project.permanently_delete")}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {pendingArchive ? (
          <View
            testID="archive-worktree-confirmation"
            style={styles.confirmation}
          >
            <Text style={styles.confirmationTitle}>{t("open_project.archive_confirmation_title")}</Text>
            <Text style={styles.confirmationBody}>
              {pendingArchive.dirty
                ? t("open_project.archive_modified", { untrackedFileCount: pendingArchive.untrackedFileCount })
                : t("open_project.archive_clean")}
            </Text>
            {!pendingArchive.baselineKnown ? (
              <Text style={styles.managedError}>
                {t("open_project.legacy_worktree_warning")}
              </Text>
            ) : null}
            <View style={styles.confirmationActions}>
              <Button
                testID="cancel-archive-worktree"
                variant="secondary"
                onPress={() => setPendingArchive(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                testID="confirm-archive-worktree"
                variant="primary"
                loading={busyWorktreePath === pendingArchive.path}
                onPress={() => void confirmArchive()}
              >
                {t("open_project.archive")}
              </Button>
            </View>
          </View>
        ) : null}

        {pendingForget ? (
          <View
            testID="forget-worktree-confirmation"
            style={styles.confirmation}
          >
            <Text style={styles.confirmationTitle}>{t("open_project.delete_snapshot_title")}</Text>
            <Text style={styles.confirmationBody}>
              {t("open_project.delete_snapshot_message", { worktreeId: pendingForget.worktreeId })}
            </Text>
            <Field
              testID="forget-worktree-name"
              label={t("open_project.worktree_id")}
              value={forgetName}
              onChangeText={setForgetName}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {pendingForget.conversations.length > 0 ? (
              <Text style={styles.managedError}>
                {t("open_project.archived_sessions_warning")}
              </Text>
            ) : null}
            <View style={styles.confirmationActions}>
              <Button
                testID="cancel-forget-worktree"
                variant="secondary"
                onPress={() => {
                  setPendingForget(null);
                  setForgetName("");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                testID="confirm-forget-worktree"
                variant="danger"
                loading={busyWorktreePath === pendingForget.path}
                disabled={
                  forgetName !== pendingForget.worktreeId ||
                  pendingForget.conversations.length > 0
                }
                onPress={() => void confirmForget()}
              >
                {t("open_project.permanently_delete")}
              </Button>
            </View>
          </View>
        ) : null}

        {mode !== "github" ? (
          <Field
            label={mode === "worktree" ? t("open_project.git_repository_directory") : t("open_project.directory")}
            value={path}
            onChangeText={setPath}
            editable={!unavailable}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/path/to/project"
          />
        ) : null}

        <View style={styles.methods}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => setMode("open")}
            style={[styles.method, mode === "open" && styles.selected]}
          >
            <Search size={19} color={colors.textMuted} />
            <View style={styles.methodCopy}>
              <Text style={styles.methodTitle}>{t("open_project.select_existing_directory")}</Text>
              <Text style={styles.methodBody}>{t("open_project.select_existing_directory_body")}</Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => setMode("create")}
            style={[styles.method, mode === "create" && styles.selected]}
          >
            <FolderPlus size={19} color={colors.textMuted} />
            <View style={styles.methodCopy}>
              <Text style={styles.methodTitle}>{t("open_project.create_directory")}</Text>
              <Text style={styles.methodBody}>{t("open_project.create_directory_body")}</Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => setMode("worktree")}
            style={[styles.method, mode === "worktree" && styles.selected]}
          >
            <FolderGit2 size={19} color={colors.textMuted} />
            <View style={styles.methodCopy}>
              <Text style={styles.methodTitle}>{t("open_project.create_git_worktree")}</Text>
              <Text style={styles.methodBody}>{t("open_project.create_git_worktree_body")}</Text>
            </View>
          </Pressable>
          <Pressable
            disabled={unavailable}
            onPress={() => {
              setMode("github");
              setError(
                t("open_project.github_unavailable_error"),
              );
            }}
            style={[styles.method, mode === "github" && styles.selected]}
          >
            <Github size={19} color={colors.textMuted} />
            <View style={styles.methodCopy}>
              <Text style={styles.methodTitle}>{t("open_project.github_clone")}</Text>
              <Text style={styles.methodBody}>
                {t("open_project.github_clone_waiting")}
              </Text>
            </View>
          </Pressable>
        </View>

        {mode === "worktree" ? (
          <Field
            label={t("open_project.git_ref_optional")}
            value={gitRef}
            onChangeText={setGitRef}
            editable={!unavailable}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("open_project.git_ref_placeholder")}
          />
        ) : null}
        {error ? (
          <Text testID="open-project-error" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {deliveryError ? <View><Text testID="workspace-open-delivery-error" style={{ color: colors.textMuted }}>{deliveryError}</Text><Button testID="retry-workspace-open-delivery" variant="secondary" disabled={deliveryChecking || loading} onPress={() => setDeliveryRevision(value => value + 1)}>{t("open_project.verify_open_result")}</Button></View> : null}
        {pendingOpened ? <Button testID="retry-opened-workspace-scope" variant="secondary" disabled={loading} onPress={() => { const entry = openedContinuation.current; if (entry) void continueOpened(entry); }}>{t("open_project.continue_ready_workspace")}</Button> : null}
        {!optionsReady && error ? <Button testID="retry-open-project-catalogs" variant="secondary" onPress={retryCatalogs}>{t("open_project.retry_project_list")}</Button> : null}
      </ScrollView>
      <View
        style={[
          styles.actionDock,
          { paddingBottom: Math.max(insets.bottom, spacing.sm) },
        ]}
      >
        <Button
          variant="primary"
          loading={loading}
          disabled={Boolean(pendingOpened || deliveryError) || deliveryChecking || loading || !optionsReady || unavailable || mode === "github" || !server || !path.trim()}
          onPress={() => void submit()}
        >
          {mode === "create"
            ? t("open_project.create_and_open")
            : mode === "worktree"
              ? t("open_project.create_worktree_action")
              : mode === "github"
                ? t("open_project.github_clone_pending")
                : t("open_project.open_project")}
        </Button>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  headerButton: { width: 46, alignItems: "center" },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  content: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  hero: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.lg },
  heroCompact: {
    flexDirection: "row",
    justifyContent: "center",
    paddingVertical: 0,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  body: {
    color: colors.textMuted,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 20,
  },
  loadingRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  label: { color: colors.text, fontSize: 13, fontWeight: "600" },
  server: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
  },
  selected: {
    borderColor: colors.green,
    backgroundColor: colors.surfaceHover,
  },
  serverText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  serverMeta: { color: colors.textDim, fontSize: 10 },
  optionsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  options: { gap: spacing.sm },
  option: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  optionCopy: { flex: 1 },
  optionTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  optionPath: { color: colors.textDim, fontSize: 11, marginTop: 3 },
  optionKind: { color: colors.textDim, fontSize: 9, fontWeight: "700" },
  emptyOptions: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  managedSection: { gap: spacing.sm, marginTop: spacing.sm },
  managedHelp: { color: colors.textDim, fontSize: 11, lineHeight: 17 },
  managedCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  managedHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  managedActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  managedButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
  },
  managedButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  dangerButton: {
    borderColor: colors.red,
    backgroundColor: colors.surface,
  },
  dangerText: { color: colors.red, fontSize: 12, fontWeight: "600" },
  managedError: { color: colors.red, fontSize: 11, lineHeight: 17 },
  confirmation: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
  },
  confirmationTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  confirmationBody: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  confirmationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  methods: { gap: spacing.sm },
  method: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
  },
  methodCopy: { flex: 1 },
  methodTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  methodBody: { color: colors.textDim, fontSize: 11, marginTop: 3 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 },
  actionDock: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
});

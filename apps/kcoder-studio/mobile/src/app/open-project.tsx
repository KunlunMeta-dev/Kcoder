import { useEffect, useMemo, useState } from "react";
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
  openWorkspace,
  prepareManagedWorktree,
  previewManagedWorktreeArchive,
  archiveManagedWorktree,
  restoreManagedWorktree,
  forgetManagedWorktree,
  type ManagedWorktree,
  type ManagedWorktreeArchivePreview,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";

type OpenMode = "open" | "create" | "worktree" | "github";

export default function OpenProjectRoute() {
  const { profileId } = useLocalSearchParams<{ profileId?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [compact, setCompact] = useState(false);
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, demo } =
    useApp();
  const goBack = () =>
    backOrReplace(router, profileHomeHref(profileId ?? activeProfile?.id));
  const profileReady =
    hydrated && (!profileId || activeProfile?.id === profileId);
  const invalidProfile =
    hydrated &&
    Boolean(profileId) &&
    !profiles.some((profile) => profile.id === profileId);
  const [serverId, setServerId] = useState("");
  const server = useMemo(
    () => runtime.servers.find((item) => item.id === serverId),
    [runtime.servers, serverId],
  );
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<OpenMode>("open");
  const [gitRef, setGitRef] = useState("");
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>(
    [],
  );
  const [managedWorktrees, setManagedWorktrees] = useState<ManagedWorktree[]>(
    [],
  );
  const [busyWorktreePath, setBusyWorktreePath] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] =
    useState<ManagedWorktreeArchivePreview | null>(null);
  const [pendingForget, setPendingForget] = useState<ManagedWorktree | null>(
    null,
  );
  const [pendingTargetKey, setPendingTargetKey] = useState<string | null>(null);
  const [forgetName, setForgetName] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverSignature = runtime.servers.map((item) => item.id).join("\0");
  const selectedTargetKey =
    activeProfile && server ? `${activeProfile.id}\0${server.id}` : null;

  useEffect(() => {
    const update = ({ window }: { window: { height: number } }) =>
      setCompact(window.height < 700);
    update({ window: Dimensions.get("window") });
    const subscription = Dimensions.addEventListener("change", update);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (
      shouldActivateRouteProfile({
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
  }, [selectedTargetKey]);

  useEffect(() => {
    if (!profileReady || runtime.loading) return;
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
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    void Promise.all([
      listWorkspaceOptions(activeProfile, server),
      listManagedWorktrees(activeProfile, server),
    ])
      .then(([items, worktrees]) => {
        if (!cancelled) {
          setWorkspaceOptions(items);
          setManagedWorktrees(worktrees);
        }
      })
      .catch((value) => {
        if (!cancelled)
          setError(value instanceof Error ? value.message : String(value));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfile?.id, demo, profileReady, runtime.loading, server?.id]);

  const selectServer = (nextServerId: string) => {
    const next = runtime.servers.find((item) => item.id === nextServerId);
    setServerId(nextServerId);
    setPath(next?.workspacePath ?? "");
    setWorkspaceOptions([]);
    setManagedWorktrees([]);
    setError(null);
  };

  const refreshManagedWorktrees = async () => {
    if (!activeProfile || !server || demo) return;
    const [options, worktrees] = await Promise.all([
      listWorkspaceOptions(activeProfile, server),
      listManagedWorktrees(activeProfile, server),
    ]);
    setWorkspaceOptions(options);
    setManagedWorktrees(worktrees);
  };

  const requestArchive = async (worktree: ManagedWorktree) => {
    if (!activeProfile || !server || busyWorktreePath) return;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      const preview = await previewManagedWorktreeArchive(
        activeProfile,
        server,
        worktree.path,
      );
      if (!preview.archiveAllowed) {
        throw new Error(
          preview.blockingReasons.join("；") || "worktree 当前不能安全归档",
        );
      }
      setPendingArchive(preview);
      setPendingTargetKey(`${activeProfile.id}\0${server.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const confirmArchive = async () => {
    if (
      !activeProfile ||
      !server ||
      !pendingArchive ||
      busyWorktreePath ||
      pendingTargetKey !== `${activeProfile.id}\0${server.id}`
    )
      return;
    const preview = pendingArchive;
    setBusyWorktreePath(preview.path);
    setError(null);
    try {
      await archiveManagedWorktree(activeProfile, server, preview, true);
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
    if (!activeProfile || !server || busyWorktreePath) return;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      await restoreManagedWorktree(activeProfile, server, worktree);
      await refreshManagedWorktrees();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyWorktreePath(null);
    }
  };

  const requestForget = (worktree: ManagedWorktree) => {
    if (!activeProfile || !server) return;
    if (worktree.conversations.length > 0) {
      setError("该 worktree 仍有关联会话，需先删除这些会话");
      return;
    }
    setPendingForget(worktree);
    setPendingTargetKey(`${activeProfile.id}\0${server.id}`);
    setForgetName("");
    setError(null);
  };

  const confirmForget = async () => {
    if (
      !activeProfile ||
      !server ||
      !pendingForget ||
      busyWorktreePath ||
      pendingTargetKey !== `${activeProfile.id}\0${server.id}`
    )
      return;
    const worktree = pendingForget;
    setBusyWorktreePath(worktree.path);
    setError(null);
    try {
      await forgetManagedWorktree(activeProfile, server, worktree);
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
      const opened = demo
        ? path.trim()
        : mode === "worktree"
          ? await prepareManagedWorktree(
              activeProfile,
              server,
              path.trim(),
              gitRef,
            )
          : await openWorkspace(
              activeProfile,
              server,
              path.trim(),
              mode === "create",
            );
      router.replace({
        pathname: "/new",
        params: {
          profileId: activeProfile.id,
          serverId: server.id,
          cwd: opened,
        },
      });
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
            accessibilityLabel="返回"
            onPress={goBack}
            style={styles.headerButton}
          >
            <ChevronLeft size={23} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>添加项目</Text>
          <View style={styles.headerButton} />
        </View>
        <EmptyState
          icon={<FolderOpen size={42} color={colors.textDim} />}
          title="Gateway 已不存在"
          body="这个项目链接指向已移除的 Gateway，请返回并选择其他连接。"
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
          accessibilityLabel="返回"
          onPress={goBack}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>添加项目</Text>
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
          <Text style={styles.title}>打开远端目录</Text>
          {!compact ? (
            <Text style={styles.body}>
              选择服务器和已登记项目，也可以输入绝对路径或创建隔离 worktree。
            </Text>
          ) : null}
        </View>

        {unavailable ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.textMuted} />
            <Text style={styles.loadingText}>正在切换 Gateway…</Text>
          </View>
        ) : null}

        <Text style={styles.label}>服务器</Text>
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
          <Text style={styles.label}>已登记项目</Text>
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
            此服务器还没有登记项目，可直接输入目录。
          </Text>
        ) : null}

        {managedWorktrees.length > 0 ? (
          <View
            testID="managed-worktrees-section"
            style={styles.managedSection}
          >
            <Text style={styles.label}>托管 worktree</Text>
            <Text style={styles.managedHelp}>
              归档会保留可恢复快照；永久删除只适用于已归档且无关联会话的记录。
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
                          {busy ? "预检中…" : "归档"}
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
                          {busy ? "恢复中…" : "恢复"}
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
                        <Text style={styles.dangerText}>永久删除</Text>
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
            <Text style={styles.confirmationTitle}>归档并保留快照？</Text>
            <Text style={styles.confirmationBody}>
              {pendingArchive.dirty
                ? `包含本地修改和 ${pendingArchive.untrackedFileCount} 个未跟踪文件。归档后可恢复，但当前目录会被移除。`
                : "预检未发现工作区修改。归档后当前目录会被移除，并保留可恢复快照。"}
            </Text>
            {!pendingArchive.baselineKnown ? (
              <Text style={styles.managedError}>
                这是升级前创建的 worktree，无法确认创建以来的 commit 数。
              </Text>
            ) : null}
            <View style={styles.confirmationActions}>
              <Button
                testID="cancel-archive-worktree"
                variant="secondary"
                onPress={() => setPendingArchive(null)}
              >
                取消
              </Button>
              <Button
                testID="confirm-archive-worktree"
                variant="primary"
                loading={busyWorktreePath === pendingArchive.path}
                onPress={() => void confirmArchive()}
              >
                归档
              </Button>
            </View>
          </View>
        ) : null}

        {pendingForget ? (
          <View
            testID="forget-worktree-confirmation"
            style={styles.confirmation}
          >
            <Text style={styles.confirmationTitle}>永久删除恢复快照？</Text>
            <Text style={styles.confirmationBody}>
              此操作不可撤销。输入 worktree ID“{pendingForget.worktreeId}
              ”以确认。
            </Text>
            <Field
              testID="forget-worktree-name"
              label="Worktree ID"
              value={forgetName}
              onChangeText={setForgetName}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {pendingForget.conversations.length > 0 ? (
              <Text style={styles.managedError}>
                仍有关联归档会话，服务端会拒绝永久删除。
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
                取消
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
                永久删除
              </Button>
            </View>
          </View>
        ) : null}

        {mode !== "github" ? (
          <Field
            label={mode === "worktree" ? "Git 仓库目录" : "目录"}
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
              <Text style={styles.methodTitle}>选择现有目录</Text>
              <Text style={styles.methodBody}>登记并打开服务器上的目录</Text>
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
              <Text style={styles.methodTitle}>新建目录</Text>
              <Text style={styles.methodBody}>由 app-server 创建并登记</Text>
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
              <Text style={styles.methodTitle}>新建 Git worktree</Text>
              <Text style={styles.methodBody}>从仓库创建临时隔离工作区</Text>
            </View>
          </Pressable>
          <Pressable
            disabled={unavailable}
            onPress={() => {
              setMode("github");
              setError(
                "TODO：KCoder app-server 尚无 GitHub repository search/clone RPC。",
              );
            }}
            style={[styles.method, mode === "github" && styles.selected]}
          >
            <Github size={19} color={colors.textMuted} />
            <View style={styles.methodCopy}>
              <Text style={styles.methodTitle}>从 GitHub 克隆</Text>
              <Text style={styles.methodBody}>
                等待 repository search/clone RPC
              </Text>
            </View>
          </Pressable>
        </View>

        {mode === "worktree" ? (
          <Field
            label="Git ref（可选）"
            value={gitRef}
            onChangeText={setGitRef}
            editable={!unavailable}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="main、分支或 commit"
          />
        ) : null}
        {error ? (
          <Text testID="open-project-error" style={styles.error}>
            {error}
          </Text>
        ) : null}
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
          disabled={unavailable || mode === "github" || !server || !path.trim()}
          onPress={() => void submit()}
        >
          {mode === "create"
            ? "创建并打开"
            : mode === "worktree"
              ? "创建 worktree"
              : mode === "github"
                ? "GitHub 克隆待接入"
                : "打开项目"}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  selected: {
    borderColor: colors.green,
    backgroundColor: "rgba(33,132,84,0.07)",
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
    borderColor: colors.border,
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
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  managedButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  dangerButton: {
    borderColor: "rgba(239,68,68,0.35)",
    backgroundColor: "rgba(239,68,68,0.06)",
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
    borderColor: colors.border,
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

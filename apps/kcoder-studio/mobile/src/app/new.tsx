import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Dimensions, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Check, ChevronDown, ChevronLeft, FolderGit2, FolderOpen, FolderPlus, Server as ServerIcon, Sparkles, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Field, StatusDot } from "@/components/ui";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { defaultModelOption, modelOptionSelector, selectedModelOption, listModels, listWorkspaceOptions, prepareManagedWorktree, TaskRuntime, taskRuntimeRegistry, type ModelOption, type WorkspaceOption } from "@/runtime/task-runtime";
import { useApp } from "@/state/AppContext";
import { loadNewWorkspacePreference, reasoningEffortLabel, saveNewWorkspacePreference, type WorkspaceIsolation } from "@/storage/new-workspace-preferences";
import { colors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { saveWorkspaceState } from "@/storage/workspace-preferences";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{ profileId?: string; serverId?: string; cwd?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [compact, setCompact] = useState(false);
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, markGatewayReauthorizationRequired, demo } = useApp();
  const goBack = () => backOrReplace(router, profileHomeHref(params.profileId ?? activeProfile?.id));
  const profileReady = hydrated && (!params.profileId || activeProfile?.id === params.profileId);
  const invalidProfile = hydrated && Boolean(params.profileId) && !profiles.some((profile) => profile.id === params.profileId);
  const [serverId, setServerId] = useState("");
  const server = useMemo(() => runtime.servers.find((item) => item.id === serverId), [runtime.servers, serverId]);
  const statusByServerId = useMemo(
    () => new Map(runtime.statuses.map((item) => [item.id, item.status])),
    [runtime.statuses],
  );
  const [cwd, setCwd] = useState("");
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [isolation, setIsolation] = useState<WorkspaceIsolation>("local");
  const [gitRef, setGitRef] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [modelSheet, setModelSheet] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [executionMode, setExecutionMode] = useState<'default' | 'orchestrate' | 'moa' | 'moa-plan'>('default');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: params.profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(params.profileId!);
    }
  }, [activeProfile?.id, hydrated, isFocused, params.profileId, profiles, setActiveProfile]);

  useEffect(() => {
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
    if (!profileReady || runtime.loading) return;
    setServerId((current) => {
      if (current && runtime.servers.some((item) => item.id === current)) return current;
      return (runtime.servers.find((item) => item.id === params.serverId) ?? runtime.servers[0])?.id ?? "";
    });
  }, [activeProfile?.id, params.serverId, profileReady, runtime.loading, serverSignature]);

  useEffect(() => {
    if (!profileReady || !activeProfile || !server) return;
    let cancelled = false;
    const routedCwd = params.serverId === server.id ? params.cwd?.trim() : undefined;
    setWorkspaceOptions([]);
    setWorkspacesLoading(true);
    const optionsPromise = demo
      ? Promise.resolve<WorkspaceOption[]>([{ path: server.workspacePath ?? "/data/projects/kcoder", label: "KCoder", kind: "workspace" }])
      : listWorkspaceOptions(activeProfile, server);
    void Promise.all([
      optionsPromise,
      loadNewWorkspacePreference(activeProfile.id, server.id).catch(() => null),
    ])
      .then(([options, preference]) => {
        if (cancelled) return;
        setWorkspaceOptions(options);
        const preferredCwd = routedCwd || preference?.cwd || server.workspacePath || options[0]?.path || "/";
        setCwd(preferredCwd);
        const preferredOption = options.find((item) => item.path === preferredCwd);
        setIsolation(preferredOption?.kind === "worktree" ? "local" : preference?.isolation ?? "local");
      })
      .catch((value) => {
        if (!cancelled) {
          setCwd(routedCwd || server.workspacePath || "/");
          setError(value instanceof Error ? value.message : String(value));
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspacesLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeProfile?.id, demo, params.cwd, params.serverId, profileReady, server?.id]);

  useEffect(() => {
    if (!profileReady || !activeProfile || !server) return;
    if (demo) {
      setModels([
        { id: "demo::MiniMax-M3", model: "MiniMax-M3", displayName: "MiniMax-M3", providerId: "kunlunmeta", providerName: "KCoder Meta", isDefault: true },
        { id: "demo::kimi-for-coding", model: "kimi-for-coding", displayName: "Kimi for Coding", providerId: "kimi", providerName: "Kimi" },
      ]);
      setModel("MiniMax-M3");
      setReasoningEffort("medium");
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModels([]);
    setModel("");
    setReasoningEffort("");
    setModelsLoading(true);
    void listModels(activeProfile, server)
      .then((values) => {
        if (cancelled) return;
        setModels(values);
        const selected = defaultModelOption(values);
        setModel(selected ? modelOptionSelector(selected) : "");
        setReasoningEffort(selected?.defaultReasoningEffort ?? "");
      })
      .catch((value) => {
        if (!cancelled) setError(value instanceof Error ? value.message : String(value));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfile?.id, demo, profileReady, server?.id]);

  const selectServer = (nextServerId: string) => {
    if (nextServerId === serverId) return;
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

  const create = async () => {
    if (!profileReady || runtime.loading || modelsLoading || workspacesLoading || !activeProfile || !server || !prompt.trim() || !cwd.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const sourceCwd = cwd.trim();
      const taskCwd = isolation === "worktree"
        ? demo
          ? `${sourceCwd.replace(/\/$/, "")}/.kcoder/worktrees/mobile-demo`
          : await prepareManagedWorktree(activeProfile, server, sourceCwd, gitRef)
        : sourceCwd;
      await saveNewWorkspacePreference(activeProfile.id, server.id, { cwd: sourceCwd, isolation }).catch(() => {});
      const task = demo
        ? TaskRuntime.demo(`demo-created-${Date.now()}`)
        : await TaskRuntime.create({ profile: activeProfile, server, cwd: taskCwd, prompt: prompt.trim(), sessionMode: executionMode === 'orchestrate' ? 'orchestrate' : undefined, turnMode: executionMode === 'moa' || executionMode === 'moa-plan' ? executionMode : undefined, model: model.trim() || undefined, reasoningEffort: reasoningEffort || undefined, managedWorktreeSourcePath: isolation === "worktree" ? server.workspacePath : undefined, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id) });
      taskRuntimeRegistry.put(activeProfile.id, server.id, task);
      await saveWorkspaceState(activeProfile.id, server.id, task.getSnapshot().threadId, {
        activeTab: "agent",
        model: model.trim() || undefined,
        reasoningEffort: reasoningEffort || undefined,
      }).catch(() => {});
      router.replace({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: task.getSnapshot().threadId, cwd: taskCwd, title: task.getSnapshot().title } });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };

  if (invalidProfile) {
    return <View style={[styles.root, { paddingTop: insets.top }]}><View style={styles.header}><Pressable accessibilityLabel="返回" onPress={goBack} style={styles.back}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>新建任务</Text><View style={styles.headerSpacer} /></View><EmptyState icon={<ServerIcon size={42} color={colors.textDim} />} title="Gateway 已不存在" body="这个新建链接指向已移除的 Gateway，请返回并选择其他连接。" /></View>;
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}><Pressable accessibilityLabel="返回" onPress={goBack} style={styles.back}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>新建任务</Text><View style={styles.headerSpacer} /></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}> 
        <View style={[styles.hero, compact && styles.heroCompact]}><View style={[styles.heroIcon, compact && styles.heroIconCompact]}><Sparkles size={compact ? 18 : 24} color={colors.text} /></View><View style={compact && styles.heroCompactCopy}><Text style={[styles.title, compact && styles.titleCompact]}>开始一个新任务</Text>{!compact ? <Text style={styles.subtitle}>选择 KCoder 服务器和工作目录，然后告诉智能体要做什么。</Text> : null}</View></View>
        {!profileReady || runtime.loading ? <View style={styles.profileLoading}><ActivityIndicator color={colors.textMuted} /><Text style={styles.profileLoadingText}>正在切换 Gateway…</Text></View> : null}
        <View style={styles.section}><Text style={styles.sectionTitle}>服务器</Text>{runtime.servers.map((item) => {
          const status = statusByServerId.get(item.id) ?? "checking";
          const statusLabel = status === "online" ? "在线" : status === "offline" ? "离线" : "检测中";
          return <Pressable key={item.id} testID={`server-option-${item.id}`} disabled={!profileReady || runtime.loading} onPress={() => selectServer(item.id)} style={[styles.serverOption, serverId === item.id && styles.serverSelected]}><ServerIcon size={19} color={serverId === item.id ? colors.blue : colors.textMuted} /><View style={styles.serverCopy}><Text style={styles.serverLabel}>{item.label}</Text><Text style={styles.serverPath} numberOfLines={1}>{item.workspacePath ?? item.description}</Text></View><View style={{ alignItems: "center", gap: 3 }}><StatusDot status={status} /><Text style={{ color: status === "offline" ? colors.textDim : colors.textMuted, fontSize: 9 }}>{statusLabel}</Text></View>{serverId === item.id ? <Check size={18} color={colors.blue} /> : null}</Pressable>;
        })}</View>
        <View style={styles.section}>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>项目</Text>{workspacesLoading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Pressable accessibilityLabel="添加项目" onPress={() => router.push({ pathname: "/open-project", params: { profileId: activeProfile?.id } })} style={styles.addProject}><FolderPlus size={16} color={colors.textMuted} /><Text style={styles.addProjectText}>添加</Text></Pressable>}</View>
          {workspaceOptions.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projectOptions}>{workspaceOptions.map((item) => <Pressable key={`${item.kind}:${item.path}`} testID={`workspace-option-${encodeURIComponent(item.path)}`} onPress={() => { setCwd(item.path); setIsolation(item.kind === "worktree" ? "local" : isolation); }} style={[styles.projectOption, cwd === item.path && styles.projectSelected]}>{item.kind === "worktree" ? <FolderGit2 size={19} color={colors.blue} /> : <FolderOpen size={19} color={colors.textMuted} />}<View style={styles.projectCopy}><Text numberOfLines={1} style={styles.projectName}>{item.label}</Text><Text numberOfLines={1} style={styles.projectPath}>{item.path}</Text></View>{cwd === item.path ? <Check size={17} color={colors.green} /> : null}</Pressable>)}</ScrollView> : !workspacesLoading ? <Text style={styles.emptyProjects}>尚未登记项目，可输入绝对路径或点击“添加”。</Text> : null}
          <Field testID="workspace-path" label="工作目录" value={cwd} onChangeText={(value) => { setCwd(value); setIsolation("local"); }} editable={profileReady && !runtime.loading && !workspacesLoading} autoCapitalize="none" autoCorrect={false} placeholder="/path/to/project" />
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>隔离方式</Text>
          <View style={styles.isolationOptions}>
            <Pressable testID="workspace-isolation-local" onPress={() => setIsolation("local")} style={[styles.isolationOption, isolation === "local" && styles.isolationSelected]}><FolderOpen size={18} color={isolation === "local" ? colors.green : colors.textMuted} /><View style={styles.isolationCopy}><Text style={styles.isolationTitle}>使用当前工作区</Text><Text style={styles.isolationBody}>直接在所选目录中工作</Text></View></Pressable>
            <Pressable testID="workspace-isolation-worktree" disabled={workspaceOptions.find((item) => item.path === cwd)?.kind === "worktree"} onPress={() => setIsolation("worktree")} style={[styles.isolationOption, isolation === "worktree" && styles.isolationSelected, workspaceOptions.find((item) => item.path === cwd)?.kind === "worktree" && styles.optionDisabled]}><FolderGit2 size={18} color={isolation === "worktree" ? colors.green : colors.textMuted} /><View style={styles.isolationCopy}><Text style={styles.isolationTitle}>新建 worktree</Text><Text style={styles.isolationBody}>创建临时 Git 隔离目录</Text></View></Pressable>
          </View>
          {isolation === "worktree" ? <Field testID="workspace-git-ref" label="Git ref（可选）" value={gitRef} onChangeText={setGitRef} autoCapitalize="none" autoCorrect={false} placeholder="分支、tag 或 commit" /> : null}
        </View>
        <View style={styles.modelField}>
          <Text style={styles.fieldLabel}>模型</Text>
          <Pressable testID="model-selector" disabled={!profileReady || runtime.loading || modelsLoading || !server} onPress={() => setModelSheet(true)} style={styles.modelSelector}>
            <View style={styles.modelCopy}>
              <Text style={styles.modelName}>{selectedModelOption(models, model)?.displayName ?? (model.split("::").at(-1) || "使用服务器默认模型")}</Text>
              <Text style={styles.modelProvider}>{selectedModelOption(models, model)?.providerName ?? "KCoder"}</Text>
            </View>
            {modelsLoading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <ChevronDown size={18} color={colors.textMuted} />}
          </Pressable>
        </View>
        {(selectedModelOption(models, model)?.supportedReasoningEfforts?.length ?? 0) > 0 ? <View style={styles.reasoning}><Text style={styles.fieldLabel}>推理强度</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reasoningOptions}>{selectedModelOption(models, model)?.supportedReasoningEfforts?.map((effort) => <Pressable key={effort} accessibilityRole="radio" aria-checked={reasoningEffort === effort} accessibilityState={{ checked: reasoningEffort === effort, disabled: !profileReady || runtime.loading || modelsLoading }} disabled={!profileReady || runtime.loading || modelsLoading} onPress={() => setReasoningEffort(effort)} style={[styles.reasoningOption, { minHeight: 44 }, reasoningEffort === effort && styles.reasoningSelected]}><Text style={[styles.reasoningText, reasoningEffort === effort && styles.reasoningSelectedText]}>{reasoningEffortLabel(effort)}</Text></Pressable>)}</ScrollView></View> : null}
      </ScrollView>
      <View style={[styles.composerDock, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.fieldLabel}>任务</Text>
          <ScrollView horizontal contentContainerStyle={styles.reasoningOptions} showsHorizontalScrollIndicator={false}>
            {(['default', 'orchestrate', 'moa', 'moa-plan'] as const).map(mode => (
              <Button key={mode} testID={`new-execution-mode-${mode}`} variant={executionMode === mode ? 'primary' : 'secondary'} disabled={loading} onPress={() => setExecutionMode(mode)}>{mode === 'default' ? '普通模式' : `/${mode}`}</Button>
            ))}
          </ScrollView>
        <View style={styles.promptRow}>
          <TextInput testID="new-workspace-prompt" value={prompt} onChangeText={setPrompt} multiline placeholder="告诉 KCoder 要完成什么…" placeholderTextColor={colors.textDim} style={styles.promptInput} />
          <Button testID="create-workspace" style={styles.createButton} variant="primary" loading={loading} disabled={!profileReady || runtime.loading || modelsLoading || workspacesLoading || !server || !prompt.trim() || !cwd.trim()} onPress={() => void create()}>{isolation === "worktree" ? "创建 worktree" : "创建"}</Button>
        </View>
      </View>
      <Modal visible={modelSheet} transparent animationType="slide" onRequestClose={closeModelSheet}>
        <Pressable style={styles.sheetOverlay} onPress={closeModelSheet} />
        <View ref={modelSheetRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.sheetHeader}><View><Text style={styles.sheetTitle}>选择模型</Text><Text style={styles.sheetSubtitle}>{server?.label}</Text></View><Pressable accessibilityLabel="关闭" onPress={() => setModelSheet(false)} style={styles.close}><X size={20} color={colors.textMuted} /></Pressable></View>
          <ScrollView style={styles.modelList}>
            {models.map((item) => (
              <Pressable key={item.id} onPress={() => { setModel(modelOptionSelector(item)); setReasoningEffort(item.defaultReasoningEffort ?? ""); setModelSheet(false); }} style={styles.modelOption}>
                <View style={styles.modelCopy}><Text style={styles.modelOptionName}>{item.displayName}</Text><Text style={styles.modelProvider}>{item.providerName}{item.supportsVision ? " · 支持图片" : ""}</Text></View>
                {selectedModelOption(models, model)?.id === item.id ? <Check size={19} color={colors.green} /> : null}
              </Pressable>
            ))}
            {models.length === 0 && !modelsLoading ? <Text style={styles.noModels}>服务器没有返回可用模型，将使用默认配置。</Text> : null}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.background }, header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm }, back: { width: 46, height: 46, alignItems: "center", justifyContent: "center" }, headerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700", textAlign: "center" }, headerSpacer: { width: 46 }, content: { padding: spacing.lg, gap: spacing.lg, maxWidth: 680, width: "100%", alignSelf: "center" }, hero: { alignItems: "center", paddingVertical: spacing.lg, gap: spacing.sm }, heroCompact: { flexDirection: "row", justifyContent: "center", paddingVertical: spacing.xs }, heroCompactCopy: { justifyContent: "center" }, heroIcon: { width: 52, height: 52, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }, heroIconCompact: { width: 36, height: 36, borderRadius: radius.md }, title: { color: colors.text, fontSize: 21, fontWeight: "700" }, titleCompact: { fontSize: 17 }, subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, textAlign: "center" }, profileLoading: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface }, profileLoadingText: { color: colors.textMuted, fontSize: 13 }, section: { gap: spacing.sm }, sectionHeader: { minHeight: 30, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, sectionTitle: { color: colors.text, fontSize: 13, fontWeight: "600" }, addProject: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: spacing.sm, borderRadius: radius.sm }, addProjectText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, projectOptions: { gap: spacing.sm, paddingRight: spacing.sm }, projectOption: { width: 248, minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface }, projectSelected: { borderColor: colors.green, backgroundColor: "rgba(33,132,84,0.07)" }, projectCopy: { flex: 1 }, projectName: { color: colors.text, fontSize: 13, fontWeight: "700" }, projectPath: { color: colors.textDim, fontSize: 10, marginTop: 4 }, emptyProjects: { color: colors.textDim, fontSize: 12, lineHeight: 18 }, isolationOptions: { flexDirection: "row", gap: spacing.sm }, isolationOption: { flex: 1, minHeight: 70, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface }, isolationSelected: { borderColor: colors.green, backgroundColor: "rgba(33,132,84,0.07)" }, isolationCopy: { flex: 1 }, isolationTitle: { color: colors.text, fontSize: 12, fontWeight: "700" }, isolationBody: { color: colors.textDim, fontSize: 10, lineHeight: 14, marginTop: 4 }, optionDisabled: { opacity: 0.4 }, serverOption: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface }, serverSelected: { borderColor: colors.blue, backgroundColor: "rgba(96,165,250,0.08)" }, serverCopy: { flex: 1 }, serverLabel: { color: colors.text, fontSize: 14, fontWeight: "600" }, serverPath: { color: colors.textDim, fontSize: 11, marginTop: 4 }, modelField: { gap: spacing.sm }, fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600" }, modelSelector: { minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface }, modelCopy: { flex: 1 }, modelName: { color: colors.text, fontSize: 14, fontWeight: "600" }, modelProvider: { color: colors.textDim, fontSize: 11, marginTop: 3 }, reasoning: { gap: spacing.sm }, reasoningOptions: { gap: spacing.sm, paddingRight: spacing.sm }, reasoningOption: { minWidth: 72, height: 38, paddingHorizontal: spacing.md, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface }, reasoningSelected: { borderColor: colors.green, backgroundColor: "rgba(33,132,84,0.08)" }, reasoningText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, reasoningSelectedText: { color: colors.green }, composerDock: { width: "100%", maxWidth: 680, alignSelf: "center", gap: 6, paddingHorizontal: spacing.md, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceRaised }, promptRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }, promptInput: { flex: 1, minHeight: 48, maxHeight: 92, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, color: colors.text, backgroundColor: colors.background, textAlignVertical: "top" }, createButton: { minWidth: 92 }, error: { color: colors.red, fontSize: 13 }, sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay }, sheet: { maxHeight: "70%", marginTop: "auto", backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, paddingTop: spacing.lg }, sheetHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, paddingBottom: spacing.md }, sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" }, sheetSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 3 }, close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, modelList: { flexGrow: 0 }, modelOption: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }, modelOptionName: { color: colors.text, fontSize: 14, fontWeight: "600" }, noModels: { color: colors.textMuted, textAlign: "center", padding: spacing.xl } });

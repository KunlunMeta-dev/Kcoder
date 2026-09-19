import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ChevronDown,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Download,
  Upload,
  RefreshCw,
  RotateCcw,
} from "lucide-react-native";
import type { FileChangesView, TaskRuntime } from "@/runtime/task-runtime";
import { colors, radius, spacing } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { EmptyState } from "./ui";
import { diffFilePaths, diffForFile, diffPathExistsAfter, diffTotals, parseGitStatus, type GitStatusFile } from "./git-diff-utils";

interface DiffLine {
  id: string;
  content: string;
  kind: "meta" | "hunk" | "add" | "delete" | "context";
  oldLine?: number;
  newLine?: number;
}

function parseDiff(diff: string): DiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return diff.split("\n").slice(0, 10_000).map((content, index) => {
    const hunk = content.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { id: `${index}:hunk`, content, kind: "hunk" as const };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { id: `${index}:add`, content, kind: "add" as const, newLine };
      if (newLine !== undefined) newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { id: `${index}:delete`, content, kind: "delete" as const, oldLine };
      if (oldLine !== undefined) oldLine += 1;
      return line;
    }
    if (content.startsWith(" ")) {
      const line = { id: `${index}:context`, content, kind: "context" as const, oldLine, newLine };
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
      return line;
    }
    return { id: `${index}:meta`, content, kind: "meta" as const };
  });
}

function allArtifacts(task: TaskRuntime): FileChangesView[] {
  const seen = new Set<string>();
  return task.getSnapshot().messages.flatMap((message) => {
    const changes = message.fileChanges;
    if (!changes || seen.has(changes.artifactId)) return [];
    seen.add(changes.artifactId);
    return [changes];
  }).reverse();
}

type ChangesMode = "working" | "staged" | "committed" | "turn";

function ChangesModeTabs({ mode, onChange, turnCount }: { mode: ChangesMode; onChange(mode: ChangesMode): void; turnCount: number }) {
  const options: Array<{ id: ChangesMode; label: string }> = [
    { id: "working", label: "工作树" },
    { id: "staged", label: "已暂存" },
    { id: "committed", label: "最近提交" },
    { id: "turn", label: turnCount > 0 ? `回合 ${turnCount}` : "回合" },
  ];
  return <View style={styles.modeTabs}>{options.map((option) => <Pressable key={option.id} testID={`changes-mode-${option.id}`} accessibilityRole="tab" accessibilityState={{ selected: mode === option.id }} onPress={() => onChange(option.id)} style={[styles.modeTab, mode === option.id && styles.modeTabActive]}><Text style={[styles.modeTabText, mode === option.id && styles.modeTabTextActive]}>{option.label}</Text></Pressable>)}</View>;
}

function DiffViewer({ diff }: { diff: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  return <ScrollView horizontal style={styles.diffViewport} contentContainerStyle={styles.diffHorizontal}><FlatList data={lines} keyExtractor={(line) => line.id} style={styles.diffList} contentContainerStyle={styles.diffTable} initialNumToRender={80} maxToRenderPerBatch={80} windowSize={9} renderItem={({ item: line }) => <View style={[styles.diffRow, line.kind === "add" && styles.addRow, line.kind === "delete" && styles.deleteRow, line.kind === "hunk" && styles.hunkRow]}><Text style={styles.lineNumber}>{line.oldLine ?? ""}</Text><Text style={styles.lineNumber}>{line.newLine ?? ""}</Text><Text selectable style={[styles.diffText, line.kind === "add" && styles.addText, line.kind === "delete" && styles.deleteText, line.kind === "hunk" && styles.hunkText, line.kind === "meta" && styles.metaText]}>{line.content || " "}</Text></View>} /></ScrollView>;
}

interface GitCommandResult { success?: boolean; stdout?: unknown; stderr?: string }
interface GitSyncStatus { dirty: boolean; hasRemote: boolean; hasUpstream: boolean; ahead: number; behind: number }

function gitCommandText(result: GitCommandResult, label: string): string {
  if (result.success === false) throw new Error(result.stderr?.trim() || `${label} 执行失败`);
  return String(result.stdout ?? "");
}

function BranchMenu({ mergeMode, currentBranch, branches, disabled, query, onQueryChange, onChoose, newBranch, onNewBranchChange, onCreate }: { mergeMode: boolean; currentBranch: string; branches: string[]; disabled: boolean; query: string; onQueryChange(value: string): void; onChoose(branch: string): void; newBranch: string; onNewBranchChange(value: string): void; onCreate(): void }) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredBranches = branches.filter((item) => item !== currentBranch && (!normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery)));
  return <View style={styles.branchMenu}>
    <Text style={styles.branchMenuTitle}>{mergeMode ? `合并到 ${currentBranch}` : "切换分支"}</Text>
    <TextInput testID="git-branch-filter" accessibilityLabel="筛选现有分支" value={query} onChangeText={onQueryChange} autoCapitalize="none" autoCorrect={false} placeholder="筛选分支…" placeholderTextColor={colors.textDim} style={styles.branchFilterInput} />
    <ScrollView style={styles.branchList} keyboardShouldPersistTaps="handled">
      {filteredBranches.map((item) => <Pressable key={item} testID={`git-branch-option-${encodeURIComponent(item)}`} accessibilityRole="button" accessibilityLabel={`${mergeMode ? "合并" : "切换到"}分支 ${item}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onChoose(item)} style={styles.branchOption}><GitBranch size={13} color={colors.textMuted} /><Text numberOfLines={1} style={styles.branchOptionText}>{item}</Text></Pressable>)}
      {filteredBranches.length === 0 ? <Text accessibilityLiveRegion="polite" style={styles.branchEmpty}>没有匹配的分支</Text> : null}
    </ScrollView>
    {!mergeMode ? <View style={styles.newBranchRow}><TextInput testID="git-new-branch-name" accessibilityLabel="新分支名称" value={newBranch} onChangeText={onNewBranchChange} autoCapitalize="none" autoCorrect={false} placeholder="新分支名称" placeholderTextColor={colors.textDim} style={styles.newBranchInput} /><Pressable accessibilityRole="button" accessibilityLabel="新建并切换分支" accessibilityState={{ disabled: !newBranch.trim() || disabled }} disabled={!newBranch.trim() || disabled} onPress={onCreate} style={[styles.newBranchButton, (!newBranch.trim() || disabled) && styles.commitDisabled]}><Text style={styles.gitActionText}>新建并切换</Text></Pressable></View> : null}
  </View>;
}

function GitWorkspaceChanges({ task, demo, mode, revision, onModeChange, onOpenFile }: { task: TaskRuntime; demo: boolean; mode: Exclude<ChangesMode, "turn">; revision: number; onModeChange(mode: ChangesMode): void; onOpenFile(path: string): void }) {
  const runtimeSnapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState<GitStatusFile[]>([]);
  const [diff, setDiff] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [localRevision, setLocalRevision] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<GitSyncStatus>({ dirty: false, hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 });
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");

  useEffect(() => {
    if (mode !== "staged") setCommitOpen(false);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    setSelectedFile(null);
    setDiff("");
    setLoading(true);
    setError(null);
    const load = async () => {
      if (demo) {
        const sample = mode === "committed"
          ? "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -3,3 +3,4 @@\n export function App() {\n+  return <MobileWorkspace />;\n }"
          : mode === "staged"
            ? "diff --git a/src/theme.ts b/src/theme.ts\n--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1,2 +1,2 @@\n-export const background = \"#fff\";\n+export const background = \"#181B1A\";"
            : "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -8,3 +8,5 @@\n   const ready = true;\n+  const mobile = true;\n+  const remote = true;";
        setBranch("mobile/paseo-alignment");
        setBranches(["main", "mobile/paseo-alignment", "release"]);
        setSyncStatus({ dirty: true, hasRemote: true, hasUpstream: true, ahead: 1, behind: 0 });
        setStatus(parseGitStatus(" M src/app.tsx\nM  src/theme.ts\n?? src/mobile.ts"));
        setDiff(sample);
        setLoading(false);
        return;
      }
      try {
        const cwd = task.getSnapshot().cwd;
        const diffCommand = mode === "working" ? "git_diff_working" : mode === "staged" ? "git_diff_staged" : "git_diff_last_commit";
        const [branchResult, statusResult, diffResult, branchesResult, syncResult] = await Promise.all([
          task.request<GitCommandResult>("device/execute", { command_key: "git_branch", path: cwd, args: [], max_output_bytes: 64 * 1024 }),
          task.request<GitCommandResult>("device/execute", { command_key: "git_status_porcelain_z", path: cwd, args: [], max_output_bytes: 512 * 1024 }),
          task.request<GitCommandResult>("device/execute", { command_key: diffCommand, path: cwd, args: [], max_output_bytes: 1_400_000, timeout_seconds: 30 }),
          task.request<GitCommandResult>("device/execute", { command_key: "git_branch_list", path: cwd, args: [], max_output_bytes: 128 * 1024 }),
          task.request<GitCommandResult>("device/execute", { command_key: "git_sync_status", path: cwd, args: [], max_output_bytes: 128 * 1024 }),
        ]);
        if (cancelled) return;
        setBranch(gitCommandText(branchResult, "读取当前分支").trim());
        setStatus(parseGitStatus(gitCommandText(statusResult, "读取 Git 状态")));
        setDiff(gitCommandText(diffResult, "读取 Git diff"));
        setBranches(gitCommandText(branchesResult, "读取分支列表").split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
        const sync = syncResult.stdout && typeof syncResult.stdout === "object" ? syncResult.stdout as Record<string, unknown> : {};
        setSyncStatus({ dirty: sync.dirty === true, hasRemote: sync.hasRemote === true, hasUpstream: sync.hasUpstream === true, ahead: Number(sync.ahead ?? 0), behind: Number(sync.behind ?? 0) });
      } catch (value) {
        if (!cancelled) setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [demo, localRevision, mode, revision, task]);

  const files = useMemo(() => mode === "working"
    ? status.filter((file) => file.working)
    : mode === "staged"
      ? status.filter((file) => file.staged)
      : diffFilePaths(diff).map((path) => ({ code: "C ", path, staged: false, working: false })), [diff, mode, status]);
  const visibleDiff = useMemo(() => diffForFile(diff, selectedFile), [diff, selectedFile]);
  const selectedStatusFile = selectedFile ? files.find((file) => file.path === selectedFile) : null;
  const selectedFileDeleted = Boolean(selectedFile && (
    mode === "committed"
      ? !diffPathExistsAfter(diff, selectedFile)
      : mode === "staged"
        ? selectedStatusFile?.code[0] === "D"
        : selectedStatusFile?.code[1] === "D"
  ));
  const totals = useMemo(() => diffTotals(diff), [diff]);
  const emptyTitle = mode === "working" ? "工作树是干净的" : mode === "staged" ? "没有已暂存变更" : "没有可显示的最近提交";
  const gitMutationDisabled = mutationBusy || runtimeSnapshot.running;

  const stageAll = async () => {
    if (runtimeSnapshot.running) {
      setError("Agent 回合运行中不能修改 Git 状态，请先停止或等待回合完成");
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", { command_key: "git_add_all", path: task.getSnapshot().cwd, args: [], max_output_bytes: 64 * 1024 });
        gitCommandText(result, "暂存文件");
      }
      onModeChange("staged");
      setLocalRevision((value) => value + 1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMutationBusy(false);
    }
  };

  const prepareCommit = async () => {
    if (runtimeSnapshot.running) {
      setError("Agent 回合运行中不能修改 Git 状态，请先停止或等待回合完成");
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (demo) setCommitMessage("Update mobile workspace");
      else {
        const result = await task.request<GitCommandResult>("device/execute", { command_key: "git_generate_commit_message", path: task.getSnapshot().cwd, args: [], max_output_bytes: 64 * 1024 });
        if (result.success === false) throw new Error(result.stderr?.trim() || "生成提交说明失败");
        const payload = result.stdout && typeof result.stdout === "object" ? result.stdout as Record<string, unknown> : {};
        if (payload.success !== true) throw new Error(String(payload.error ?? "没有可提交的暂存变更"));
        setCommitMessage(String(payload.message ?? "Update files"));
      }
      setCommitOpen(true);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMutationBusy(false);
    }
  };

  const commit = async () => {
    if (runtimeSnapshot.running) {
      setError("Agent 回合运行中不能修改 Git 状态，请先停止或等待回合完成");
      return;
    }
    const message = commitMessage.trim();
    if (!message) return;
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", { command_key: "git_commit", path: task.getSnapshot().cwd, args: ["-m", message], max_output_bytes: 512 * 1024, timeout_seconds: 60 });
        gitCommandText(result, "创建提交");
      }
      setCommitOpen(false);
      setCommitMessage("");
      onModeChange("committed");
      setLocalRevision((value) => value + 1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMutationBusy(false);
    }
  };

  const mutate = async (commandKey: string, args: string[], label: string) => {
    if (runtimeSnapshot.running) {
      setError("Agent 回合运行中不能修改 Git 状态，请先停止或等待回合完成");
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", { command_key: commandKey, path: task.getSnapshot().cwd, args, max_output_bytes: 512 * 1024, timeout_seconds: 120 });
        gitCommandText(result, label);
      }
      setBranchMenuOpen(false);
      setMergeMode(false);
      setBranchQuery("");
      setNewBranch("");
      setLocalRevision((value) => value + 1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMutationBusy(false);
    }
  };

  const chooseBranch = (target: string) => {
    if (runtimeSnapshot.running || syncStatus.dirty) return;
    const merging = mergeMode;
    requestConfirmation({
      title: merging ? `合并 ${target}？` : `切换到 ${target}？`,
      message: merging ? `将 ${target} 合入当前分支 ${branch}；发生冲突时服务端会自动 abort。` : "切换分支会改变当前工作区内容。",
      confirmLabel: merging ? "合并" : "切换",
      onConfirm: () => void mutate(merging ? "git_merge" : "git_checkout", [target], merging ? "合并分支" : "切换分支"),
    });
  };

  return <View style={styles.gitBody}><View style={styles.gitSummary}><Pressable accessibilityRole="button" accessibilityLabel={`当前分支 ${branch || "detached HEAD"}，打开分支菜单`} accessibilityState={{ expanded: branchMenuOpen }} onPress={() => { setMergeMode(false); setBranchQuery(""); setBranchMenuOpen((value) => !value); }} style={styles.gitSummaryCopy}><View style={styles.branchRow}><GitBranch size={14} color={colors.textMuted} /><Text numberOfLines={1} style={styles.branchText}>{branch || "detached HEAD"}</Text><ChevronDown size={14} color={colors.textDim} /></View><Text style={styles.gitMeta}>{files.length} 个文件 · ↑{syncStatus.ahead} ↓{syncStatus.behind}</Text></Pressable><Text style={styles.additions}>+{totals.additions}</Text><Text style={styles.deletions}>-{totals.deletions}</Text>{files.length > 0 && mode === "working" ? <Pressable testID="git-stage-all" accessibilityState={{ disabled: gitMutationDisabled || loading }} disabled={gitMutationDisabled || loading} onPress={() => void stageAll()} style={styles.gitAction}>{mutationBusy ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.gitActionText}>全部暂存</Text>}</Pressable> : null}{files.length > 0 && mode === "staged" ? <Pressable testID="git-open-commit" accessibilityState={{ disabled: gitMutationDisabled || loading }} disabled={gitMutationDisabled || loading} onPress={() => void prepareCommit()} style={styles.gitAction}>{mutationBusy ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.gitActionText}>提交</Text>}</Pressable> : null}</View><View style={styles.gitSyncActions}><Pressable accessibilityLabel="拉取远端提交" accessibilityState={{ disabled: gitMutationDisabled || syncStatus.dirty || !syncStatus.hasUpstream }} disabled={gitMutationDisabled || syncStatus.dirty || !syncStatus.hasUpstream} onPress={() => void mutate("git_pull_ff", [], "拉取远端提交")} style={[styles.gitSyncButton, (gitMutationDisabled || syncStatus.dirty || !syncStatus.hasUpstream) && styles.commitDisabled]}><Download size={14} color={colors.textMuted} /><Text style={styles.gitSyncText}>Pull</Text></Pressable><Pressable accessibilityLabel="推送当前分支" accessibilityState={{ disabled: gitMutationDisabled || !syncStatus.hasRemote }} disabled={gitMutationDisabled || !syncStatus.hasRemote} onPress={() => void mutate("git_push", [], "推送当前分支")} style={[styles.gitSyncButton, (gitMutationDisabled || !syncStatus.hasRemote) && styles.commitDisabled]}><Upload size={14} color={colors.textMuted} /><Text style={styles.gitSyncText}>Push</Text></Pressable><Pressable accessibilityLabel="选择要合并的分支" accessibilityState={{ disabled: gitMutationDisabled || syncStatus.dirty }} disabled={gitMutationDisabled || syncStatus.dirty} onPress={() => { setMergeMode(true); setBranchQuery(""); setBranchMenuOpen(true); }} style={[styles.gitSyncButton, (gitMutationDisabled || syncStatus.dirty) && styles.commitDisabled]}><GitMerge size={14} color={colors.textMuted} /><Text style={styles.gitSyncText}>Merge</Text></Pressable></View>{branchMenuOpen ? <BranchMenu mergeMode={mergeMode} currentBranch={branch} branches={branches} disabled={gitMutationDisabled || syncStatus.dirty} query={branchQuery} onQueryChange={setBranchQuery} onChoose={chooseBranch} newBranch={newBranch} onNewBranchChange={setNewBranch} onCreate={() => void mutate("git_checkout_new", [newBranch.trim()], "新建分支")} /> : null}{commitOpen ? <View style={styles.commitComposer}><TextInput testID="git-commit-message" value={commitMessage} onChangeText={setCommitMessage} multiline maxLength={10_000} autoCapitalize="sentences" placeholder="提交说明" placeholderTextColor={colors.textDim} style={styles.commitInput} /><Pressable accessibilityLabel="取消提交" accessibilityState={{ disabled: gitMutationDisabled }} disabled={gitMutationDisabled} onPress={() => setCommitOpen(false)} style={styles.commitButton}><Text style={styles.commitCancelText}>取消</Text></Pressable><Pressable testID="git-commit" accessibilityLabel="创建提交" accessibilityState={{ disabled: gitMutationDisabled || !commitMessage.trim() }} disabled={gitMutationDisabled || !commitMessage.trim()} onPress={() => void commit()} style={[styles.commitButton, styles.commitConfirm, (gitMutationDisabled || !commitMessage.trim()) && styles.commitDisabled]}>{mutationBusy ? <ActivityIndicator size="small" color={colors.accentText} /> : <Text style={styles.commitConfirmText}>提交</Text>}</Pressable></View> : null}{files.length > 0 ? <FlatList horizontal data={[null, ...files.map((file) => file.path)] as Array<string | null>} keyExtractor={(item) => item ?? "__all__"} showsHorizontalScrollIndicator={false} style={styles.gitFileRail} contentContainerStyle={styles.fileRailContent} renderItem={({ item }) => { const active = selectedFile === item; const statusFile = item ? files.find((file) => file.path === item) : null; return <Pressable onPress={() => setSelectedFile(item)} style={[styles.fileChip, active && styles.fileChipActive]}>{statusFile ? <Text style={styles.statusCode}>{statusFile.code.trim() || "M"}</Text> : <FileCode2 size={13} color={active ? colors.text : colors.textDim} />}<Text numberOfLines={1} style={[styles.fileChipText, active && styles.fileChipTextActive]}>{item ? item.split("/").pop() : "全部"}</Text></Pressable>; }} /> : null}{selectedFile ? <OpenFileBar path={selectedFile} onOpen={onOpenFile} deleted={selectedFileDeleted} /> : null}{loading ? <View style={styles.loading}><ActivityIndicator color={colors.textMuted} /><Text style={styles.loadingText}>正在读取 Git 工作树…</Text></View> : null}{error ? <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}{!loading && !error && files.length === 0 && !diff ? <EmptyState icon={<GitCompareArrows size={42} color={colors.textDim} />} title={emptyTitle} body={mode === "committed" ? "当前仓库还没有可显示的提交差异。" : "切换到其他分组可查看不同阶段的文件差异。"} /> : null}{!loading && !error && files.length > 0 && !visibleDiff ? <EmptyState icon={<FileCode2 size={42} color={colors.textDim} />} title="没有文本 diff" body="所选项目可能是未跟踪、二进制或重命名文件，可在 Files 工作区中查看。" /> : null}{visibleDiff ? <DiffViewer diff={visibleDiff} /> : null}</View>;
}

function OpenFileBar({ path, onOpen, deleted }: { path: string; onOpen(path: string): void; deleted: boolean }) {
  return <View style={styles.openFileBar}><Text numberOfLines={1} style={styles.openFilePath}>{path}</Text><Pressable testID="changes-open-file" accessibilityRole="button" accessibilityLabel={deleted ? `${path} 已删除` : `在 Files 打开 ${path}`} accessibilityState={{ disabled: deleted }} disabled={deleted} onPress={() => onOpen(path)} style={[styles.openFileButton, deleted && styles.commitDisabled]}>{deleted ? null : <ExternalLink size={14} color={colors.text} />}<Text style={styles.openFileButtonText}>{deleted ? "文件已删除" : "在 Files 打开"}</Text></Pressable></View>;
}

export function ChangesPanel({ task, demo, onOpenFile }: { task: TaskRuntime; demo: boolean; onOpenFile(path: string): void }) {
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  const artifacts = useMemo(() => allArtifacts(task), [snapshot.messages, task]);
  const [artifactId, setArtifactId] = useState<string | null>(artifacts[0]?.artifactId ?? null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertedIds, setRevertedIds] = useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<ChangesMode>("working");
  const [gitRevision, setGitRevision] = useState(0);

  const changes = artifacts.find((item) => item.artifactId === artifactId) ?? artifacts[0] ?? null;
  const reverted = Boolean(changes && (changes.status === "reverted" || revertedIds.has(changes.artifactId)));

  useEffect(() => {
    if (!changes && artifacts[0]) setArtifactId(artifacts[0].artifactId);
  }, [artifacts, changes]);

  useEffect(() => {
    setSelectedFile(null);
    setDiff(null);
    setError(null);
  }, [changes?.artifactId]);

  const review = useCallback(async () => {
    if (!changes) return;
    setLoading(true);
    setError(null);
    try {
      if (demo) {
        setDiff(`diff --git a/src/app.tsx b/src/app.tsx\nindex 7c92a43..14db971 100644\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -18,6 +18,8 @@ export function App() {\n   const ready = true;\n+  const mobile = true;\n+  const theme = \"dark\";\n   return <Workspace />;\ndiff --git a/src/theme.ts b/src/theme.ts\nindex 9a4b221..0db3881 100644\n--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1,4 +1,4 @@\n-export const background = \"#fff\";\n+export const background = \"#181B1A\";\n export const foreground = \"#fafafa\";`);
        return;
      }
      const result = await task.request<{ stdout?: unknown }>("device/execute", {
        command_key: "turn_file_changes_review",
        threadId: snapshot.threadId,
        path: changes.workspacePath,
        args: [changes.artifactId],
        max_output_bytes: 1_048_576,
      });
      const stdout = result.stdout && typeof result.stdout === "object"
        ? result.stdout as Record<string, unknown>
        : {};
      setDiff(String(stdout.diff ?? ""));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [changes, demo, task]);

  useEffect(() => {
    if (mode === "turn" && changes && !reverted && diff === null && !loading && !error) void review();
  }, [changes, diff, error, loading, mode, reverted, review]);

  const revert = () => {
    if (!changes) return;
    requestConfirmation({
      title: "撤销此回合的文件变更？",
      message: "若文件之后又被修改，服务端会拒绝撤销，避免覆盖开发者的新内容。",
      confirmLabel: "撤销变更",
      destructive: true,
      onConfirm: () => void (async () => {
        if (demo) {
          setRevertedIds((current) => new Set([...current, changes.artifactId]));
          setDiff(null);
          setSelectedFile(null);
          return;
        }
        setLoading(true);
        setError(null);
        try {
          const result = await task.request<{ success?: boolean; stdout?: unknown; stderr?: string }>("device/execute", {
            command_key: "turn_file_changes_revert",
            threadId: snapshot.threadId,
            path: changes.workspacePath,
            args: [changes.artifactId],
            max_output_bytes: 1_048_576,
          });
          const stdout = result.stdout && typeof result.stdout === "object" ? result.stdout as Record<string, unknown> : {};
          const authoritative = stdout.file_changes && typeof stdout.file_changes === "object"
            ? stdout.file_changes as Record<string, unknown>
            : {};
          if (result.success !== true || stdout.success !== true || authoritative.status !== "reverted") {
            throw new Error(result.stderr || String(stdout.error ?? "服务端未确认撤销"));
          }
          setRevertedIds((current) => new Set([...current, changes.artifactId]));
          setDiff(null);
          setSelectedFile(null);
        } catch (value) {
          setError(value instanceof Error ? value.message : String(value));
        } finally {
          setLoading(false);
        }
      })(),
    });
  };

  const visibleDiff = useMemo(() => diffForFile(diff ?? "", selectedFile), [diff, selectedFile]);

  if (mode !== "turn") {
    return (
      <View testID="changes-panel" style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTitle}><GitCompareArrows size={17} color={colors.textMuted} /><Text style={styles.title}>Changes</Text></View>
          <Pressable accessibilityLabel="刷新 Git 变更" onPress={() => setGitRevision((value) => value + 1)} style={styles.iconButton}><RefreshCw size={16} color={colors.textMuted} /></Pressable>
        </View>
        <ChangesModeTabs mode={mode} onChange={setMode} turnCount={artifacts.length} />
        <GitWorkspaceChanges task={task} demo={demo} mode={mode} revision={gitRevision} onModeChange={setMode} onOpenFile={onOpenFile} />
      </View>
    );
  }

  if (!changes) {
    return (
      <View testID="changes-panel" style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTitle}><GitCompareArrows size={17} color={colors.textMuted} /><Text style={styles.title}>Changes</Text></View>
        </View>
        <ChangesModeTabs mode={mode} onChange={setMode} turnCount={0} />
        <EmptyState icon={<GitCompareArrows size={46} color={colors.textDim} />} title="暂无回合变更" body="智能体修改文件后，这里会显示可审查、可安全撤销的逐行 diff。" />
      </View>
    );
  }

  return (
    <View testID="changes-panel" style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerTitle}><GitCompareArrows size={17} color={colors.textMuted} /><Text style={styles.title}>Changes</Text></View>
        <Pressable accessibilityLabel="刷新 diff" disabled={loading} onPress={() => { setDiff(null); setError(null); }} style={styles.iconButton}>{loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={16} color={colors.textMuted} />}</Pressable>
      </View>
      <ChangesModeTabs mode={mode} onChange={setMode} turnCount={artifacts.length} />
      <View style={styles.summary}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyOpen }} onPress={() => setHistoryOpen((value) => !value)} style={styles.summaryMain}>
          <View style={styles.summaryCopy}><Text style={styles.summaryTitle}>{changes.fileCount} 个已更改文件</Text><Text numberOfLines={1} style={styles.workspacePath}>{changes.workspacePath}</Text></View>
          <Text style={styles.additions}>+{changes.additions}</Text><Text style={styles.deletions}>-{changes.deletions}</Text>
          {artifacts.length > 1 ? <ChevronDown size={16} color={colors.textDim} /> : null}
        </Pressable>
        {changes.revertible && !reverted ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading }} accessibilityLabel="撤销本回合变更" disabled={loading} onPress={revert} style={styles.revertButton}><RotateCcw size={15} color={colors.red} /><Text style={styles.revertText}>撤销</Text></Pressable> : <Text style={styles.reverted}>{reverted ? "已撤销" : "只读"}</Text>}
      </View>
      {historyOpen && artifacts.length > 1 ? <FlatList style={styles.history} data={artifacts} keyExtractor={(item) => item.artifactId} renderItem={({ item, index }) => <Pressable onPress={() => { setArtifactId(item.artifactId); setHistoryOpen(false); }} style={[styles.historyRow, item.artifactId === changes.artifactId && styles.historyRowActive]}><Text style={styles.historyTitle}>回合变更 {artifacts.length - index}</Text><Text style={styles.historyStats}>+{item.additions} -{item.deletions}</Text></Pressable>} /> : null}
      <View style={styles.body}>
        <View style={styles.fileRail}>
          <FlatList
            horizontal
            data={[null, ...changes.files] as Array<string | null>}
            keyExtractor={(item) => item ?? "__all__"}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.fileRailContent}
            renderItem={({ item }) => {
              const active = selectedFile === item;
              return <Pressable onPress={() => setSelectedFile(item)} style={[styles.fileChip, active && styles.fileChipActive]}><FileCode2 size={13} color={active ? colors.text : colors.textDim} /><Text numberOfLines={1} style={[styles.fileChipText, active && styles.fileChipTextActive]}>{item ? item.split("/").pop() : "全部"}</Text></Pressable>;
            }}
          />
        </View>
        {selectedFile ? <OpenFileBar path={selectedFile} onOpen={onOpenFile} deleted={false} /> : null}
        {error ? <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{error}</Text><Pressable onPress={() => void review()} style={styles.retry}><Text style={styles.retryText}>重试</Text></Pressable></View> : null}
        {loading && !diff ? <View style={styles.loading}><ActivityIndicator color={colors.textMuted} /><Text style={styles.loadingText}>正在读取服务端 diff…</Text></View> : null}
        {!loading && !error && (reverted || diff !== null) && !visibleDiff ? <EmptyState icon={<FileCode2 size={42} color={colors.textDim} />} title={reverted ? "变更已撤销" : "没有可显示的 diff"} body={selectedFile ? "该文件没有文本 diff，可能是二进制文件、重命名，或已被撤销。" : "服务端没有返回文本差异。"} /> : null}
        {visibleDiff ? <DiffViewer diff={visibleDiff} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 44, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceSidebar },
  headerTitle: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.md },
  title: { color: colors.text, fontSize: 13, fontWeight: "700" },
  iconButton: { width: 48, height: 44, alignItems: "center", justifyContent: "center" },
  modeTabs: { height: 44, flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceSidebar },
  modeTab: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  modeTabActive: { borderBottomColor: colors.accentBright },
  modeTabText: { color: colors.textDim, fontSize: 10, fontWeight: "600" },
  modeTabTextActive: { color: colors.text },
  gitBody: { flex: 1 },
  gitSummary: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  gitSummaryCopy: { flex: 1, minWidth: 0 },
  branchRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  branchText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "600" },
  gitMeta: { color: colors.textDim, fontSize: 10, marginTop: 4 },
  gitAction: { minWidth: 68, height: 44, marginLeft: spacing.xs, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  gitActionText: { color: colors.text, fontSize: 10, fontWeight: "700" },
  gitSyncActions: { minHeight: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceSidebar }, gitSyncButton: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs }, gitSyncText: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  branchMenu: { maxHeight: 356, padding: spacing.sm, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceRaised }, branchMenuTitle: { color: colors.textMuted, fontSize: 11, fontWeight: "700", paddingHorizontal: spacing.xs }, branchFilterInput: { minHeight: 44, paddingHorizontal: spacing.md, color: colors.text, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.background }, branchList: { maxHeight: 180 }, branchOption: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, branchOptionText: { flex: 1, color: colors.text, fontSize: 12 }, branchEmpty: { minHeight: 52, color: colors.textDim, fontSize: 11, textAlign: "center", textAlignVertical: "center", paddingVertical: spacing.md }, newBranchRow: { flexDirection: "row", gap: spacing.sm }, newBranchInput: { flex: 1, minHeight: 44, paddingHorizontal: spacing.md, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.background }, newBranchButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface },
  commitComposer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.xs, padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceSidebar },
  commitInput: { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 96, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.text, fontSize: 12, textAlignVertical: "top", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.background },
  commitButton: { minWidth: 52, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  commitConfirm: { backgroundColor: colors.accent },
  commitDisabled: { opacity: 0.4 },
  commitCancelText: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  commitConfirmText: { color: colors.accentText, fontSize: 11, fontWeight: "700" },
  gitFileRail: { flexGrow: 0, height: 53, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  statusCode: { width: 24, color: colors.yellow, fontFamily: "monospace", fontSize: 10, fontWeight: "700" },
  summary: { minHeight: 62, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface, paddingLeft: spacing.md },
  summaryMain: { flex: 1, minWidth: 0, minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  summaryCopy: { flex: 1, minWidth: 0 },
  summaryTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  workspacePath: { color: colors.textDim, fontSize: 9, marginTop: 3 },
  additions: { color: colors.green, fontFamily: "monospace", fontSize: 11 },
  deletions: { color: colors.red, fontFamily: "monospace", fontSize: 11 },
  revertButton: { minWidth: 68, height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginHorizontal: spacing.xs },
  revertText: { color: colors.red, fontSize: 11, fontWeight: "600" },
  reverted: { color: colors.textDim, fontSize: 10, marginHorizontal: spacing.md },
  history: { position: "absolute", zIndex: 10, top: 150, left: spacing.md, right: spacing.md, maxHeight: 288, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  historyRow: { minHeight: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  historyRowActive: { backgroundColor: colors.surfaceHover },
  historyTitle: { flex: 1, color: colors.text, fontSize: 12 },
  historyStats: { color: colors.textDim, fontFamily: "monospace", fontSize: 10 },
  body: { flex: 1 },
  fileRail: { height: 53, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  fileRailContent: { gap: spacing.xs, alignItems: "center", paddingHorizontal: spacing.sm },
  fileChip: { maxWidth: 180, height: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  fileChipActive: { borderColor: colors.borderAccent, backgroundColor: colors.surfaceRaised },
  fileChipText: { maxWidth: 142, color: colors.textDim, fontSize: 10 },
  fileChipTextActive: { color: colors.text },
  openFileBar: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceSidebar },
  openFilePath: { flex: 1, minWidth: 0, color: colors.textDim, fontFamily: "monospace", fontSize: 9 },
  openFileButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.md },
  openFileButtonText: { color: colors.text, fontSize: 10, fontWeight: "700" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  error: { flexDirection: "row", alignItems: "center", gap: spacing.md, margin: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: "rgba(198,79,67,0.14)" },
  errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  retry: { minWidth: 52, height: 44, alignItems: "center", justifyContent: "center" },
  retryText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  diffViewport: { flex: 1 },
  diffHorizontal: { minWidth: "100%", height: "100%" },
  diffList: { minWidth: "100%", height: "100%" },
  diffTable: { flexGrow: 1, minWidth: "100%", paddingVertical: spacing.sm },
  diffRow: { minHeight: 20, flexDirection: "row", alignItems: "stretch", paddingRight: spacing.md },
  addRow: { backgroundColor: "rgba(34,197,94,0.12)" },
  deleteRow: { backgroundColor: "rgba(198,79,67,0.14)" },
  hunkRow: { backgroundColor: "rgba(106,157,224,0.12)", marginVertical: 3 },
  lineNumber: { width: 42, color: colors.textDim, fontFamily: "monospace", fontSize: 10, lineHeight: 20, textAlign: "right", paddingRight: spacing.sm, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  diffText: { minWidth: 520, color: colors.textMuted, fontFamily: "monospace", fontSize: 10, lineHeight: 20, paddingLeft: spacing.sm },
  addText: { color: "#A7E3BB" },
  deleteText: { color: "#EDAAA4" },
  hunkText: { color: colors.blue },
  metaText: { color: colors.textDim },
});

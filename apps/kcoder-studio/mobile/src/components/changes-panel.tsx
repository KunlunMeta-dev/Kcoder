import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { EmptyState } from "./ui";
import {
  diffFilePaths,
  diffForFile,
  diffPathExistsAfter,
  diffTotals,
  parseGitStatus,
  type GitStatusFile,
} from "./git-diff-utils";

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
  return diff
    .split("\n")
    .slice(0, 10_000)
    .map((content, index) => {
      const hunk = content.match(
        /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/,
      );
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return { id: `${index}:hunk`, content, kind: "hunk" as const };
      }
      if (content.startsWith("+") && !content.startsWith("+++")) {
        const line = {
          id: `${index}:add`,
          content,
          kind: "add" as const,
          newLine,
        };
        if (newLine !== undefined) newLine += 1;
        return line;
      }
      if (content.startsWith("-") && !content.startsWith("---")) {
        const line = {
          id: `${index}:delete`,
          content,
          kind: "delete" as const,
          oldLine,
        };
        if (oldLine !== undefined) oldLine += 1;
        return line;
      }
      if (content.startsWith(" ")) {
        const line = {
          id: `${index}:context`,
          content,
          kind: "context" as const,
          oldLine,
          newLine,
        };
        if (oldLine !== undefined) oldLine += 1;
        if (newLine !== undefined) newLine += 1;
        return line;
      }
      return { id: `${index}:meta`, content, kind: "meta" as const };
    });
}

function allArtifacts(task: TaskRuntime): FileChangesView[] {
  const seen = new Set<string>();
  return task
    .getSnapshot()
    .messages.flatMap((message) => {
      const changes = message.fileChanges;
      if (!changes || seen.has(changes.artifactId)) return [];
      seen.add(changes.artifactId);
      return [changes];
    })
    .reverse();
}

type ChangesMode = "working" | "staged" | "committed" | "turn";

function ChangesModeTabs({
  mode,
  onChange,
  turnCount,
}: {
  mode: ChangesMode;
  onChange(mode: ChangesMode): void;
  turnCount: number;
}) {
  useLocale();
  const styles = useChangesStyles();
  const options: Array<{ id: ChangesMode; label: string }> = [
    { id: "working", label: t("task.working_tree") },
    { id: "staged", label: t("task.staged") },
    { id: "committed", label: t("task.recent_commits") },
    {
      id: "turn",
      label:
        turnCount > 0
          ? t("task.turn_with_value", { p0: turnCount })
          : t("task.turn"),
    },
  ];
  return (
    <View style={styles.modeTabs}>
      {options.map((option) => (
        <Pressable
          key={option.id}
          testID={`changes-mode-${option.id}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === option.id }}
          onPress={() => onChange(option.id)}
          style={[styles.modeTab, mode === option.id && styles.modeTabActive]}
        >
          <Text
            style={[
              styles.modeTabText,
              mode === option.id && styles.modeTabTextActive,
            ]}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const styles = useChangesStyles();
  const lines = useMemo(() => parseDiff(diff), [diff]);
  return (
    <ScrollView
      horizontal
      style={styles.diffViewport}
      contentContainerStyle={styles.diffHorizontal}
    >
      <FlatList
        data={lines}
        keyExtractor={(line) => line.id}
        style={styles.diffList}
        contentContainerStyle={styles.diffTable}
        initialNumToRender={80}
        maxToRenderPerBatch={80}
        windowSize={9}
        renderItem={({ item: line }) => (
          <View
            style={[
              styles.diffRow,
              line.kind === "add" && styles.addRow,
              line.kind === "delete" && styles.deleteRow,
              line.kind === "hunk" && styles.hunkRow,
            ]}
          >
            <Text style={styles.lineNumber}>{line.oldLine ?? ""}</Text>
            <Text style={styles.lineNumber}>{line.newLine ?? ""}</Text>
            <Text
              selectable
              style={[
                styles.diffText,
                line.kind === "add" && styles.addText,
                line.kind === "delete" && styles.deleteText,
                line.kind === "hunk" && styles.hunkText,
                line.kind === "meta" && styles.metaText,
              ]}
            >
              {line.content || " "}
            </Text>
          </View>
        )}
      />
    </ScrollView>
  );
}

interface GitCommandResult {
  success?: boolean;
  stdout?: unknown;
  stderr?: string;
}
interface GitSyncStatus {
  dirty: boolean;
  hasRemote: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}

function gitCommandText(result: GitCommandResult, label: string): string {
  if (result.success === false)
    throw new Error(
      result.stderr?.trim() || t("task.failed_with_value", { p0: label }),
    );
  return String(result.stdout ?? "");
}

function BranchMenu({
  mergeMode,
  currentBranch,
  branches,
  disabled,
  query,
  onQueryChange,
  onChoose,
  newBranch,
  onNewBranchChange,
  onCreate,
}: {
  mergeMode: boolean;
  currentBranch: string;
  branches: string[];
  disabled: boolean;
  query: string;
  onQueryChange(value: string): void;
  onChoose(branch: string): void;
  newBranch: string;
  onNewBranchChange(value: string): void;
  onCreate(): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useChangesStyles();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredBranches = branches.filter(
    (item) =>
      item !== currentBranch &&
      (!normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery)),
  );
  return (
    <View style={styles.branchMenu}>
      <Text style={styles.branchMenuTitle}>
        {mergeMode
          ? t("task.merge_into", { p0: currentBranch })
          : t("task.switch_branch")}
      </Text>
      <TextInput
        testID="git-branch-filter"
        accessibilityLabel={t("task.filter_existing_branches")}
        value={query}
        onChangeText={onQueryChange}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t("task.filter_branches")}
        placeholderTextColor={colors.textDim}
        style={styles.branchFilterInput}
      />
      <ScrollView style={styles.branchList} keyboardShouldPersistTaps="handled">
        {filteredBranches.map((item) => (
          <Pressable
            key={item}
            testID={`git-branch-option-${encodeURIComponent(item)}`}
            accessibilityRole="button"
            accessibilityLabel={t("task.branch", {
              p0: mergeMode ? t("task.merge") : t("task.switch_to"),
              p1: item,
            })}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onChoose(item)}
            style={styles.branchOption}
          >
            <GitBranch size={13} color={colors.textMuted} />
            <Text numberOfLines={1} style={styles.branchOptionText}>
              {item}
            </Text>
          </Pressable>
        ))}
        {filteredBranches.length === 0 ? (
          <Text accessibilityLiveRegion="polite" style={styles.branchEmpty}>
            {t("task.no_matching_branches")}
          </Text>
        ) : null}
      </ScrollView>
      {!mergeMode ? (
        <View style={styles.newBranchRow}>
          <TextInput
            testID="git-new-branch-name"
            accessibilityLabel={t("task.new_branch_name")}
            value={newBranch}
            onChangeText={onNewBranchChange}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("task.new_branch_name")}
            placeholderTextColor={colors.textDim}
            style={styles.newBranchInput}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.create_and_switch_branch")}
            accessibilityState={{ disabled: !newBranch.trim() || disabled }}
            disabled={!newBranch.trim() || disabled}
            onPress={onCreate}
            style={[
              styles.newBranchButton,
              (!newBranch.trim() || disabled) && styles.commitDisabled,
            ]}
          >
            <Text style={styles.gitActionText}>
              {t("task.create_and_switch")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function GitWorkspaceChanges({
  task,
  demo,
  mode,
  revision,
  onModeChange,
  onOpenFile,
}: {
  task: TaskRuntime;
  demo: boolean;
  mode: Exclude<ChangesMode, "turn">;
  revision: number;
  onModeChange(mode: ChangesMode): void;
  onOpenFile(path: string): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useChangesStyles();
  const runtimeSnapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
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
  const [syncStatus, setSyncStatus] = useState<GitSyncStatus>({
    dirty: false,
    hasRemote: false,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
  });
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
        const sample =
          mode === "committed"
            ? "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -3,3 +3,4 @@\n export function App() {\n+  return <MobileWorkspace />;\n }"
            : mode === "staged"
              ? 'diff --git a/src/theme.ts b/src/theme.ts\n--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1,2 +1,2 @@\n-export const background = "#fff";\n+export const background = "#181B1A";'
              : "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -8,3 +8,5 @@\n   const ready = true;\n+  const mobile = true;\n+  const remote = true;";
        setBranch("mobile/paseo-alignment");
        setBranches(["main", "mobile/paseo-alignment", "release"]);
        setSyncStatus({
          dirty: true,
          hasRemote: true,
          hasUpstream: true,
          ahead: 1,
          behind: 0,
        });
        setStatus(
          parseGitStatus(" M src/app.tsx\nM  src/theme.ts\n?? src/mobile.ts"),
        );
        setDiff(sample);
        setLoading(false);
        return;
      }
      try {
        const cwd = task.getSnapshot().cwd;
        const diffCommand =
          mode === "working"
            ? "git_diff_working"
            : mode === "staged"
              ? "git_diff_staged"
              : "git_diff_last_commit";
        const [
          branchResult,
          statusResult,
          diffResult,
          branchesResult,
          syncResult,
        ] = await Promise.all([
          task.request<GitCommandResult>("device/execute", {
            command_key: "git_branch",
            path: cwd,
            args: [],
            max_output_bytes: 64 * 1024,
          }),
          task.request<GitCommandResult>("device/execute", {
            command_key: "git_status_porcelain_z",
            path: cwd,
            args: [],
            max_output_bytes: 512 * 1024,
          }),
          task.request<GitCommandResult>("device/execute", {
            command_key: diffCommand,
            path: cwd,
            args: [],
            max_output_bytes: 1_400_000,
            timeout_seconds: 30,
          }),
          task.request<GitCommandResult>("device/execute", {
            command_key: "git_branch_list",
            path: cwd,
            args: [],
            max_output_bytes: 128 * 1024,
          }),
          task.request<GitCommandResult>("device/execute", {
            command_key: "git_sync_status",
            path: cwd,
            args: [],
            max_output_bytes: 128 * 1024,
          }),
        ]);
        if (cancelled) return;
        setBranch(
          gitCommandText(branchResult, t("task.read_current_branch")).trim(),
        );
        setStatus(
          parseGitStatus(
            gitCommandText(statusResult, t("task.read_git_status")),
          ),
        );
        setDiff(gitCommandText(diffResult, t("task.read_git_diff")));
        setBranches(
          gitCommandText(branchesResult, t("task.read_branch_list"))
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        );
        const sync =
          syncResult.stdout && typeof syncResult.stdout === "object"
            ? (syncResult.stdout as Record<string, unknown>)
            : {};
        setSyncStatus({
          dirty: sync.dirty === true,
          hasRemote: sync.hasRemote === true,
          hasUpstream: sync.hasUpstream === true,
          ahead: Number(sync.ahead ?? 0),
          behind: Number(sync.behind ?? 0),
        });
      } catch (value) {
        if (!cancelled)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [demo, localRevision, mode, revision, task]);

  const files = useMemo(
    () =>
      mode === "working"
        ? status.filter((file) => file.working)
        : mode === "staged"
          ? status.filter((file) => file.staged)
          : diffFilePaths(diff).map((path) => ({
              code: "C ",
              path,
              staged: false,
              working: false,
            })),
    [diff, mode, status],
  );
  const visibleDiff = useMemo(
    () => diffForFile(diff, selectedFile),
    [diff, selectedFile],
  );
  const selectedStatusFile = selectedFile
    ? files.find((file) => file.path === selectedFile)
    : null;
  const selectedFileDeleted = Boolean(
    selectedFile &&
    (mode === "committed"
      ? !diffPathExistsAfter(diff, selectedFile)
      : mode === "staged"
        ? selectedStatusFile?.code[0] === "D"
        : selectedStatusFile?.code[1] === "D"),
  );
  const totals = useMemo(() => diffTotals(diff), [diff]);
  const emptyTitle =
    mode === "working"
      ? t("task.the_working_tree_is_clean")
      : mode === "staged"
        ? t("task.no_staged_changes")
        : t("task.no_recent_commits_to_display");
  const gitMutationDisabled = mutationBusy || runtimeSnapshot.running;

  const stageAll = async () => {
    if (runtimeSnapshot.running) {
      setError(t("task.git_state_cannot_change_while_the_agent_turn"));
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", {
          command_key: "git_add_all",
          path: task.getSnapshot().cwd,
          args: [],
          max_output_bytes: 64 * 1024,
        });
        gitCommandText(result, t("task.stage_files"));
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
      setError(t("task.git_state_cannot_change_while_the_agent_turn"));
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (demo) setCommitMessage("Update mobile workspace");
      else {
        const result = await task.request<GitCommandResult>("device/execute", {
          command_key: "git_generate_commit_message",
          path: task.getSnapshot().cwd,
          args: [],
          max_output_bytes: 64 * 1024,
        });
        if (result.success === false)
          throw new Error(
            result.stderr?.trim() ||
              t("task.unable_to_generate_a_commit_message"),
          );
        const payload =
          result.stdout && typeof result.stdout === "object"
            ? (result.stdout as Record<string, unknown>)
            : {};
        if (payload.success !== true)
          throw new Error(
            String(payload.error ?? t("task.no_staged_changes_to_commit")),
          );
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
      setError(t("task.git_state_cannot_change_while_the_agent_turn"));
      return;
    }
    const message = commitMessage.trim();
    if (!message) return;
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", {
          command_key: "git_commit",
          path: task.getSnapshot().cwd,
          args: ["-m", message],
          max_output_bytes: 512 * 1024,
          timeout_seconds: 60,
        });
        gitCommandText(result, t("task.create_commit"));
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
      setError(t("task.git_state_cannot_change_while_the_agent_turn"));
      return;
    }
    setMutationBusy(true);
    setError(null);
    try {
      if (!demo) {
        const result = await task.request<GitCommandResult>("device/execute", {
          command_key: commandKey,
          path: task.getSnapshot().cwd,
          args,
          max_output_bytes: 512 * 1024,
          timeout_seconds: 120,
        });
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
      title: merging
        ? t("task.merge_with_value", { p0: target })
        : t("task.switch_to_with_value", { p0: target }),
      message: merging
        ? t("task.merge_into_the_current_branch_the_server_will", {
            p0: target,
            p1: branch,
          })
        : t("task.switching_branches_changes_the_current_workspace_content"),
      confirmLabel: merging ? t("task.merge") : t("task.switch"),
      onConfirm: () =>
        void mutate(
          merging ? "git_merge" : "git_checkout",
          [target],
          merging ? t("task.merge_branches") : t("task.switch_branch"),
        ),
    });
  };

  return (
    <View style={styles.gitBody}>
      <View style={styles.gitSummary}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("task.current_branch_open_branch_menu", {
            p0: branch || "detached HEAD",
          })}
          accessibilityState={{ expanded: branchMenuOpen }}
          onPress={() => {
            setMergeMode(false);
            setBranchQuery("");
            setBranchMenuOpen((value) => !value);
          }}
          style={styles.gitSummaryCopy}
        >
          <View style={styles.branchRow}>
            <GitBranch size={14} color={colors.textMuted} />
            <Text numberOfLines={1} style={styles.branchText}>
              {branch || "detached HEAD"}
            </Text>
            <ChevronDown size={14} color={colors.textDim} />
          </View>
          <Text style={styles.gitMeta}>
            {files.length} {t("task.files")}
            {syncStatus.ahead} ↓{syncStatus.behind}
          </Text>
        </Pressable>
        <Text style={styles.additions}>+{totals.additions}</Text>
        <Text style={styles.deletions}>-{totals.deletions}</Text>
        {files.length > 0 && mode === "working" ? (
          <Pressable
            testID="git-stage-all"
            accessibilityState={{ disabled: gitMutationDisabled || loading }}
            disabled={gitMutationDisabled || loading}
            onPress={() => void stageAll()}
            style={styles.gitAction}
          >
            {mutationBusy ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={styles.gitActionText}>{t("task.stage_all")}</Text>
            )}
          </Pressable>
        ) : null}
        {files.length > 0 && mode === "staged" ? (
          <Pressable
            testID="git-open-commit"
            accessibilityState={{ disabled: gitMutationDisabled || loading }}
            disabled={gitMutationDisabled || loading}
            onPress={() => void prepareCommit()}
            style={styles.gitAction}
          >
            {mutationBusy ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={styles.gitActionText}>{t("task.commit")}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
      <View style={styles.gitSyncActions}>
        <Pressable
          accessibilityLabel={t("task.pull_remote_commits")}
          accessibilityState={{
            disabled:
              gitMutationDisabled ||
              syncStatus.dirty ||
              !syncStatus.hasUpstream,
          }}
          disabled={
            gitMutationDisabled || syncStatus.dirty || !syncStatus.hasUpstream
          }
          onPress={() =>
            void mutate("git_pull_ff", [], t("task.pull_remote_commits"))
          }
          style={[
            styles.gitSyncButton,
            (gitMutationDisabled ||
              syncStatus.dirty ||
              !syncStatus.hasUpstream) &&
              styles.commitDisabled,
          ]}
        >
          <Download size={14} color={colors.textMuted} />
          <Text style={styles.gitSyncText}>{t("task.pull")}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t("task.push_current_branch")}
          accessibilityState={{
            disabled: gitMutationDisabled || !syncStatus.hasRemote,
          }}
          disabled={gitMutationDisabled || !syncStatus.hasRemote}
          onPress={() =>
            void mutate("git_push", [], t("task.push_current_branch"))
          }
          style={[
            styles.gitSyncButton,
            (gitMutationDisabled || !syncStatus.hasRemote) &&
              styles.commitDisabled,
          ]}
        >
          <Upload size={14} color={colors.textMuted} />
          <Text style={styles.gitSyncText}>{t("task.push")}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t("task.select_a_branch_to_merge")}
          accessibilityState={{
            disabled: gitMutationDisabled || syncStatus.dirty,
          }}
          disabled={gitMutationDisabled || syncStatus.dirty}
          onPress={() => {
            setMergeMode(true);
            setBranchQuery("");
            setBranchMenuOpen(true);
          }}
          style={[
            styles.gitSyncButton,
            (gitMutationDisabled || syncStatus.dirty) && styles.commitDisabled,
          ]}
        >
          <GitMerge size={14} color={colors.textMuted} />
          <Text style={styles.gitSyncText}>{t("task.merge")}</Text>
        </Pressable>
      </View>
      {branchMenuOpen ? (
        <BranchMenu
          mergeMode={mergeMode}
          currentBranch={branch}
          branches={branches}
          disabled={gitMutationDisabled || syncStatus.dirty}
          query={branchQuery}
          onQueryChange={setBranchQuery}
          onChoose={chooseBranch}
          newBranch={newBranch}
          onNewBranchChange={setNewBranch}
          onCreate={() =>
            void mutate(
              "git_checkout_new",
              [newBranch.trim()],
              t("task.create_branch"),
            )
          }
        />
      ) : null}
      {commitOpen ? (
        <View style={styles.commitComposer}>
          <TextInput
            testID="git-commit-message"
            value={commitMessage}
            onChangeText={setCommitMessage}
            multiline
            maxLength={10_000}
            autoCapitalize="sentences"
            placeholder={t("task.commit_message")}
            placeholderTextColor={colors.textDim}
            style={styles.commitInput}
          />
          <Pressable
            accessibilityLabel={t("task.cancel_commit")}
            accessibilityState={{ disabled: gitMutationDisabled }}
            disabled={gitMutationDisabled}
            onPress={() => setCommitOpen(false)}
            style={styles.commitButton}
          >
            <Text style={styles.commitCancelText}>{t("task.cancel")}</Text>
          </Pressable>
          <Pressable
            testID="git-commit"
            accessibilityLabel={t("task.create_commit")}
            accessibilityState={{
              disabled: gitMutationDisabled || !commitMessage.trim(),
            }}
            disabled={gitMutationDisabled || !commitMessage.trim()}
            onPress={() => void commit()}
            style={[
              styles.commitButton,
              styles.commitConfirm,
              (gitMutationDisabled || !commitMessage.trim()) &&
                styles.commitDisabled,
            ]}
          >
            {mutationBusy ? (
              <ActivityIndicator size="small" color={colors.accentText} />
            ) : (
              <Text style={styles.commitConfirmText}>{t("task.commit")}</Text>
            )}
          </Pressable>
        </View>
      ) : null}
      {files.length > 0 ? (
        <FlatList
          horizontal
          data={
            [null, ...files.map((file) => file.path)] as Array<string | null>
          }
          keyExtractor={(item) => item ?? "__all__"}
          showsHorizontalScrollIndicator={false}
          style={styles.gitFileRail}
          contentContainerStyle={styles.fileRailContent}
          renderItem={({ item }) => {
            const active = selectedFile === item;
            const statusFile = item
              ? files.find((file) => file.path === item)
              : null;
            return (
              <Pressable
                onPress={() => setSelectedFile(item)}
                style={[styles.fileChip, active && styles.fileChipActive]}
              >
                {statusFile ? (
                  <Text style={styles.statusCode}>
                    {statusFile.code.trim() || "M"}
                  </Text>
                ) : (
                  <FileCode2
                    size={13}
                    color={active ? colors.text : colors.textDim}
                  />
                )}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.fileChipText,
                    active && styles.fileChipTextActive,
                  ]}
                >
                  {item ? item.split("/").pop() : t("task.all")}
                </Text>
              </Pressable>
            );
          }}
        />
      ) : null}
      {selectedFile ? (
        <OpenFileBar
          path={selectedFile}
          onOpen={onOpenFile}
          deleted={selectedFileDeleted}
        />
      ) : null}
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>
            {t("task.loading_the_git_working_tree")}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      {!loading && !error && files.length === 0 && !diff ? (
        <EmptyState
          icon={<GitCompareArrows size={42} color={colors.textDim} />}
          title={emptyTitle}
          body={
            mode === "committed"
              ? t("task.this_repository_has_no_commit_diff_to_display")
              : t("task.switch_groups_to_view_file_changes_at_different")
          }
        />
      ) : null}
      {!loading && !error && files.length > 0 && !visibleDiff ? (
        <EmptyState
          icon={<FileCode2 size={42} color={colors.textDim} />}
          title={t("task.no_text_diff")}
          body={t("task.the_selection_may_be_untracked_binary_or_renamed")}
        />
      ) : null}
      {visibleDiff ? <DiffViewer diff={visibleDiff} /> : null}
    </View>
  );
}

function OpenFileBar({
  path,
  onOpen,
  deleted,
}: {
  path: string;
  onOpen(path: string): void;
  deleted: boolean;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useChangesStyles();
  return (
    <View style={styles.openFileBar}>
      <Text numberOfLines={1} style={styles.openFilePath}>
        {path}
      </Text>
      <Pressable
        testID="changes-open-file"
        accessibilityRole="button"
        accessibilityLabel={
          deleted
            ? t("task.deleted", { p0: path })
            : t("task.open_in_files_with_value", { p0: path })
        }
        accessibilityState={{ disabled: deleted }}
        disabled={deleted}
        onPress={() => onOpen(path)}
        style={[styles.openFileButton, deleted && styles.commitDisabled]}
      >
        {deleted ? null : <ExternalLink size={14} color={colors.text} />}
        <Text style={styles.openFileButtonText}>
          {deleted ? t("task.file_deleted") : t("task.open_in_files")}
        </Text>
      </Pressable>
    </View>
  );
}

export function ChangesPanel({
  task,
  demo,
  onOpenFile,
}: {
  task: TaskRuntime;
  demo: boolean;
  onOpenFile(path: string): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useChangesStyles();
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  const artifacts = useMemo(
    () => allArtifacts(task),
    [snapshot.messages, task],
  );
  const [artifactId, setArtifactId] = useState<string | null>(
    artifacts[0]?.artifactId ?? null,
  );
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
  const reviewGeneration = useRef(0);
  const reviewSelection = useRef({
    task,
    threadId: snapshot.threadId,
    artifactId: changes?.artifactId ?? null,
  });
  reviewSelection.current = {
    task,
    threadId: snapshot.threadId,
    artifactId: changes?.artifactId ?? null,
  };

  useEffect(() => {
    if (!changes && artifacts[0]) setArtifactId(artifacts[0].artifactId);
  }, [artifacts, changes]);

  useEffect(() => {
    reviewGeneration.current += 1;
    setSelectedFile(null);
    setDiff(null);
    setError(null);
    setLoading(false);
  }, [changes?.artifactId, snapshot.threadId, task]);

  const selectArtifact = (nextArtifactId: string) => {
    reviewGeneration.current += 1;
    reviewSelection.current = {
      task,
      threadId: snapshot.threadId,
      artifactId: nextArtifactId,
    };
    setArtifactId(nextArtifactId);
    setHistoryOpen(false);
    setSelectedFile(null);
    setDiff(null);
    setError(null);
    setLoading(false);
  };

  const review = useCallback(async () => {
    if (!changes) return;
    const target = changes;
    const threadId = snapshot.threadId;
    const generation = ++reviewGeneration.current;
    const isCurrent = () => {
      const selection = reviewSelection.current;
      return generation === reviewGeneration.current
        && selection.task === task
        && selection.threadId === threadId
        && selection.artifactId === target.artifactId;
    };
    setLoading(true);
    setError(null);
    try {
      if (demo) {
        setDiff(
          `diff --git a/src/app.tsx b/src/app.tsx\nindex 7c92a43..14db971 100644\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -18,6 +18,8 @@ export function App() {\n   const ready = true;\n+  const mobile = true;\n+  const theme = \"dark\";\n   return <Workspace />;\ndiff --git a/src/theme.ts b/src/theme.ts\nindex 9a4b221..0db3881 100644\n--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1,4 +1,4 @@\n-export const background = \"#fff\";\n+export const background = \"#181B1A\";\n export const foreground = \"#fafafa\";`,
        );
        return;
      }
      const result = await task.request<{ stdout?: unknown }>("device/execute", {
        command_key: "turn_file_changes_review",
        threadId,
        path: target.workspacePath,
        args: [target.artifactId],
        max_output_bytes: 1_048_576,
      });
      if (!isCurrent()) return;
      const stdout = result.stdout && typeof result.stdout === "object"
        ? result.stdout as Record<string, unknown>
        : {};
      setDiff(String(stdout.diff ?? ""));
    } catch (value) {
      if (isCurrent())
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [changes, demo, snapshot.threadId, task]);

  useEffect(() => {
    if (
      mode === "turn" &&
      changes &&
      !reverted &&
      diff === null &&
      !loading &&
      !error
    )
      void review();
  }, [changes, diff, error, loading, mode, reverted, review]);

  const revert = () => {
    if (!changes) return;
    const target = changes;
    const threadId = snapshot.threadId;
    requestConfirmation({
      title: t("task.revert_this_turns_file_changes"),
      message: t("task.if_files_were_modified_again_the_server_will"),
      confirmLabel: t("task.revert_changes"),
      destructive: true,
      onConfirm: () => void (async () => {
        const generation = reviewGeneration.current;
        const isCurrent = () => {
          const selection = reviewSelection.current;
          return generation === reviewGeneration.current
            && selection.task === task
            && selection.threadId === threadId
            && selection.artifactId === target.artifactId;
        };
        if (demo) {
          if (isCurrent()) {
            setRevertedIds((current) => new Set([...current, target.artifactId]));
            setDiff(null);
            setSelectedFile(null);
          }
          return;
        }
        if (isCurrent()) {
          setLoading(true);
          setError(null);
        }
        try {
          const result = await task.request<{ success?: boolean; stdout?: unknown; stderr?: string }>("device/execute", {
            command_key: "turn_file_changes_revert",
            threadId,
            path: target.workspacePath,
            args: [target.artifactId],
            max_output_bytes: 1_048_576,
          });
          const stdout = result.stdout && typeof result.stdout === "object" ? result.stdout as Record<string, unknown> : {};
          const authoritative = stdout.file_changes && typeof stdout.file_changes === "object"
            ? stdout.file_changes as Record<string, unknown>
            : {};
          if (result.success !== true || stdout.success !== true || authoritative.status !== "reverted") {
            throw new Error(result.stderr || String(stdout.error ?? t("task.the_server_did_not_confirm_the_revert")));
          }
          setRevertedIds((current) => new Set([...current, target.artifactId]));
          if (!isCurrent()) return;
          setDiff(null);
          setSelectedFile(null);
        } catch (value) {
          if (isCurrent())
            setError(value instanceof Error ? value.message : String(value));
        } finally {
          if (isCurrent()) setLoading(false);
        }
      })(),
    });
  };

  const visibleDiff = useMemo(
    () => diffForFile(diff ?? "", selectedFile),
    [diff, selectedFile],
  );

  if (mode !== "turn") {
    return (
      <View testID="changes-panel" style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTitle}>
            <GitCompareArrows size={17} color={colors.textMuted} />
            <Text style={styles.title}>{t("task.changes")}</Text>
          </View>
          <Pressable
            accessibilityLabel={t("task.refresh_git_changes")}
            onPress={() => setGitRevision((value) => value + 1)}
            style={styles.iconButton}
          >
            <RefreshCw size={16} color={colors.textMuted} />
          </Pressable>
        </View>
        <ChangesModeTabs
          mode={mode}
          onChange={setMode}
          turnCount={artifacts.length}
        />
        <GitWorkspaceChanges
          task={task}
          demo={demo}
          mode={mode}
          revision={gitRevision}
          onModeChange={setMode}
          onOpenFile={onOpenFile}
        />
      </View>
    );
  }

  if (!changes) {
    return (
      <View testID="changes-panel" style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTitle}>
            <GitCompareArrows size={17} color={colors.textMuted} />
            <Text style={styles.title}>{t("task.changes")}</Text>
          </View>
        </View>
        <ChangesModeTabs mode={mode} onChange={setMode} turnCount={0} />
        <EmptyState
          icon={<GitCompareArrows size={46} color={colors.textDim} />}
          title={t("task.no_turn_changes")}
          body={t("task.when_the_agent_changes_files_review_linebyline_diffs")}
        />
      </View>
    );
  }

  return (
    <View testID="changes-panel" style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <GitCompareArrows size={17} color={colors.textMuted} />
          <Text style={styles.title}>{t("task.changes")}</Text>
        </View>
        <Pressable
          accessibilityLabel={t("task.refresh_diff")}
          disabled={loading}
          onPress={() => {
            setDiff(null);
            setError(null);
          }}
          style={styles.iconButton}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <RefreshCw size={16} color={colors.textMuted} />
          )}
        </Pressable>
      </View>
      {historyOpen && artifacts.length > 1 ? <FlatList style={styles.history} data={artifacts} keyExtractor={(item) => item.artifactId} renderItem={({ item, index }) => <Pressable onPress={() => selectArtifact(item.artifactId)} style={[styles.historyRow, item.artifactId === changes.artifactId && styles.historyRowActive]}><Text style={styles.historyTitle}>{t("task.turn_changes")}{artifacts.length - index}</Text><Text style={styles.historyStats}>+{item.additions} -{item.deletions}</Text></Pressable>} /> : null}
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
              return (
                <Pressable
                  onPress={() => setSelectedFile(item)}
                  style={[styles.fileChip, active && styles.fileChipActive]}
                >
                  <FileCode2
                    size={13}
                    color={active ? colors.text : colors.textDim}
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.fileChipText,
                      active && styles.fileChipTextActive,
                    ]}
                  >
                    {item ? item.split("/").pop() : t("task.all")}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
        {selectedFile ? (
          <OpenFileBar
            path={selectedFile}
            onOpen={onOpenFile}
            deleted={false}
          />
        ) : null}
        {error ? (
          <View accessibilityRole="alert" style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => void review()} style={styles.retry}>
              <Text style={styles.retryText}>{t("task.retry")}</Text>
            </Pressable>
          </View>
        ) : null}
        {loading && !diff ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.textMuted} />
            <Text style={styles.loadingText}>
              {t("task.loading_the_server_diff")}
            </Text>
          </View>
        ) : null}
        {!loading && !error && (reverted || diff !== null) && !visibleDiff ? (
          <EmptyState
            icon={<FileCode2 size={42} color={colors.textDim} />}
            title={
              reverted
                ? t("task.changes_reverted")
                : t("task.no_diff_to_display")
            }
            body={
              selectedFile
                ? t("task.this_file_has_no_text_diff_it_may")
                : t("task.the_server_returned_no_text_diff")
            }
          />
        ) : null}
        {visibleDiff ? <DiffViewer diff={visibleDiff} /> : null}
      </View>
    </View>
  );
}

function useChangesStyles() {
  return useThemedStyles(makeStyles);
}

function colorWithAlpha(color: string, alpha: number): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) return color;
  const [, red, green, blue] = match;
  return `rgba(${parseInt(red, 16)},${parseInt(green, 16)},${parseInt(blue, 16)},${alpha})`;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  headerTitle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.md,
  },
  title: { color: colors.text, fontSize: 13, fontWeight: "700" },
  iconButton: {
    width: 48,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  modeTabs: {
    height: 44,
    flexDirection: "row",
    alignItems: "stretch",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  modeTab: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  modeTabActive: { borderBottomColor: colors.accentBright },
  modeTabText: { color: colors.textDim, fontSize: 10, fontWeight: "600" },
  modeTabTextActive: { color: colors.text },
  gitBody: { flex: 1 },
  gitSummary: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  gitSummaryCopy: { flex: 1, minWidth: 0 },
  branchRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  branchText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "600" },
  gitMeta: { color: colors.textDim, fontSize: 10, marginTop: 4 },
  gitAction: {
    minWidth: 68,
    height: 44,
    marginLeft: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  gitActionText: { color: colors.text, fontSize: 10, fontWeight: "700" },
  gitSyncActions: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  gitSyncButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  gitSyncText: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  branchMenu: {
    maxHeight: 356,
    padding: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  branchMenuTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: spacing.xs,
  },
  branchFilterInput: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  branchList: { maxHeight: 180 },
  branchOption: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  branchOptionText: { flex: 1, color: colors.text, fontSize: 12 },
  branchEmpty: {
    minHeight: 52,
    color: colors.textDim,
    fontSize: 11,
    textAlign: "center",
    textAlignVertical: "center",
    paddingVertical: spacing.md,
  },
  newBranchRow: { flexDirection: "row", gap: spacing.sm },
  newBranchInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  newBranchButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  commitComposer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.xs,
    padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  commitInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 12,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  commitButton: {
    minWidth: 52,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  commitConfirm: { backgroundColor: colors.accent },
  commitDisabled: { opacity: 0.4 },
  commitCancelText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  commitConfirmText: {
    color: colors.accentText,
    fontSize: 11,
    fontWeight: "700",
  },
  gitFileRail: {
    flexGrow: 0,
    height: 53,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statusCode: {
    width: 24,
    color: colors.yellow,
    fontFamily: "monospace",
    fontSize: 10,
    fontWeight: "700",
  },
  summary: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    paddingLeft: spacing.md,
  },
  summaryMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  summaryCopy: { flex: 1, minWidth: 0 },
  summaryTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  workspacePath: { color: colors.textDim, fontSize: 9, marginTop: 3 },
  additions: { color: colors.green, fontFamily: "monospace", fontSize: 11 },
  deletions: { color: colors.red, fontFamily: "monospace", fontSize: 11 },
  revertButton: {
    minWidth: 68,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginHorizontal: spacing.xs,
  },
  revertText: { color: colors.red, fontSize: 11, fontWeight: "600" },
  reverted: {
    color: colors.textDim,
    fontSize: 10,
    marginHorizontal: spacing.md,
  },
  history: {
    position: "absolute",
    zIndex: 10,
    top: 150,
    left: spacing.md,
    right: spacing.md,
    maxHeight: 288,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  historyRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  historyRowActive: { backgroundColor: colors.surfaceHover },
  historyTitle: { flex: 1, color: colors.text, fontSize: 12 },
  historyStats: {
    color: colors.textDim,
    fontFamily: "monospace",
    fontSize: 10,
  },
  body: { flex: 1 },
  fileRail: {
    height: 53,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  fileRailContent: {
    gap: spacing.xs,
    alignItems: "center",
    paddingHorizontal: spacing.sm,
  },
  fileChip: {
    maxWidth: 180,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  fileChipActive: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.surfaceRaised,
  },
  fileChipText: { maxWidth: 142, color: colors.textDim, fontSize: 10 },
  fileChipTextActive: { color: colors.text },
  openFileBar: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  openFilePath: {
    flex: 1,
    minWidth: 0,
    color: colors.textDim,
    fontFamily: "monospace",
    fontSize: 9,
  },
  openFileButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  openFileButtonText: { color: colors.text, fontSize: 10, fontWeight: "700" },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  error: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    margin: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colorWithAlpha(colors.red, 0.14),
  },
  errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  retry: {
    minWidth: 52,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  diffViewport: { flex: 1 },
  diffHorizontal: { minWidth: "100%", height: "100%" },
  diffList: { minWidth: "100%", height: "100%" },
  diffTable: { flexGrow: 1, minWidth: "100%", paddingVertical: spacing.sm },
  diffRow: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "stretch",
    paddingRight: spacing.md,
  },
  addRow: { backgroundColor: colorWithAlpha(colors.green, 0.12) },
  deleteRow: { backgroundColor: colorWithAlpha(colors.red, 0.14) },
  hunkRow: { backgroundColor: colorWithAlpha(colors.blue, 0.12), marginVertical: 3 },
  lineNumber: {
    width: 42,
    color: colors.textDim,
    fontFamily: "monospace",
    fontSize: 10,
    lineHeight: 20,
    textAlign: "right",
    paddingRight: spacing.sm,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  diffText: {
    minWidth: 520,
    color: colors.textMuted,
    fontFamily: "monospace",
    fontSize: 10,
    lineHeight: 20,
    paddingLeft: spacing.sm,
  },
  addText: { color: colors.green },
  deleteText: { color: colors.red },
  hunkText: { color: colors.blue },
  metaText: { color: colors.textDim },
});

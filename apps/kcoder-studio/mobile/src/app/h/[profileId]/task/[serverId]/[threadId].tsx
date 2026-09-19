import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import {
  EncodingType,
  cacheDirectory,
  deleteAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Sharing from "expo-sharing";
import { toByteArray } from "base64-js";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import {
  ArrowUp,
  ArrowDown,
  ArchiveRestore,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Download,
  Globe2,
  GitCompareArrows,
  ListTodo,
  MoreHorizontal,
  Image as ImageIcon,
  FileUp,
  Paperclip,
  PanelLeft,
  Plus,
  ShieldCheck,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalCard, QuestionCard } from "@/components/interaction-cards";
import {
  MAX_ATTACHMENTS_PER_TURN,
  remainingAttachmentSlots,
} from "@/components/attachment-selection";
import {
  DIRECT_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
  uploadStagedAttachment,
} from "@/components/attachment-upload";
import { MobileDrawer } from "@/components/mobile-drawer";
import { ThreadListProjection, threadListScopeKey, threadListNotice } from "@/runtime/thread-list-projection";
import { WorkspaceTabSwitcher } from "@/components/workspace-tab-switcher";
import { ChangesPanel } from "@/components/changes-panel";
import { runtimeErrorSummary } from "@/components/runtime-error";
import {
  BrowserPanel,
  FilesPanel,
  TerminalPanel,
} from "@/components/workspace-panels";
import {
  workspaceFileLocationFromLink,
  workspaceFilePathFromInlineCode,
} from "@/components/workspace-file-links";
import { EmptyState } from "@/components/ui";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import {
  listModels,
  modelOptionSelector,
  selectedModelOption as findSelectedModelOption,
  listThreads,
  listWorkspaceOptions,
  TaskRuntime,
  taskRuntimeRegistry,
  type ChatMessage,
  type FileChangesView,
  type ModelOption,
  type StagedAttachment,
  type ThreadGoal,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import { useApp } from "@/state/AppContext";
import {
  loadWorkspaceState,
  removeWorkspaceState,
  saveWorkspaceState,
  type WorkspaceFileDraft,
  type WorkspacePanelState,
  type WorkspaceTab,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";
import { colors, radius, spacing } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { taskMessageQueue } from "@/runtime/task-message-queue";
import {
  MAX_QUEUED_TASK_MESSAGES,
  MAX_TASK_MESSAGE_CHARACTERS,
} from "@/protocol/task-message-limits";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import {
  filterMobileSlashCommands,
  isMobileSlashCommandInput,
  parseMobileGoalSlashAction,
  parseMobileSlashCommand,
  type MobileSlashCommand,
} from "@/components/composer-slash";
import {
  beginProgrammaticFollow,
  initialMessageFollowState,
  observeMessageListDistance,
  shouldAnchorLatest,
  stopFollowingLatest,
} from "@/components/message-follow-state";

function taskOpenError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (/lease|already.*(?:active|running)|another.*client/i.test(message)) {
    return "该任务正在另一个客户端运行。请先停止另一端的回合，再点击返回后重试。";
  }
  if (/session.*(?:expired|invalid)|authentication/i.test(message))
    return "Gateway 会话已失效，请在设置中重新连接。";
  return message;
}

function goalLabel(goal: ThreadGoal): string {
  return goal.mode === "strict"
    ? "Goal Pro"
    : goal.mode === "arrangement"
      ? "UltGoal"
      : "Goal";
}

function goalStatusNotice(goal: ThreadGoal | null): string {
  if (!goal) return "当前没有目标";
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`;
  return `${goalLabel(goal)} · ${goal.status} · ${goal.tokensUsed}${budget} tokens · ${goal.timeUsedSeconds}s\n${goal.objective}`;
}

function goalHistoryNotice(
  goals: ThreadGoal[],
  mode: ThreadGoal["mode"],
): string {
  if (goals.length === 0) return "没有已完成、阻塞或达到限额的目标历史";
  const requestedLabel =
    mode === "strict"
      ? "Goal Pro"
      : mode === "arrangement"
        ? "UltGoal"
        : "Goal";
  return `${requestedLabel} 历史：\n${goals
    .slice(-20)
    .reverse()
    .map((goal) => `${goal.status} · ${goal.mode} · ${goal.objective}`)
    .join("\n")}`;
}

function goalIsUnfinished(goal: ThreadGoal): boolean {
  return (
    goal.status === "active" ||
    goal.status === "paused" ||
    goal.status === "blocked"
  );
}

const PREVIEWABLE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/tiff",
]);

interface AttachmentAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  blob?: Blob;
  base64?: string | null;
}

type ComposerStagedAttachment = StagedAttachment & {
  localPreviewUri?: string;
  ownsLocalPreviewUri?: boolean;
};

function wireAttachment(
  attachment: ComposerStagedAttachment,
): StagedAttachment {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    path: attachment.path,
  };
}

function releaseLocalAttachmentPreview(
  attachment: ComposerStagedAttachment,
): void {
  if (
    attachment.ownsLocalPreviewUri &&
    attachment.localPreviewUri &&
    globalThis.URL?.revokeObjectURL
  ) {
    globalThis.URL.revokeObjectURL(attachment.localPreviewUri);
  }
}

function previewableRasterMimeType(value: string): string | null {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized && PREVIEWABLE_RASTER_MIME_TYPES.has(normalized)
    ? normalized
    : null;
}

async function webBlobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("无法读取所选文件"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("浏览器未返回有效的文件内容"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function webBase64Blob(base64: string, mimeType: string): Blob {
  const normalized = base64.includes(",")
    ? base64.slice(base64.indexOf(",") + 1)
    : base64;
  const binary = globalThis.atob(normalized.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function compressWebImage(blob: Blob): Promise<Blob> {
  if (!globalThis.document || typeof createImageBitmap !== "function")
    return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    for (const variant of [
      { width: 1600, quality: 0.72 },
      { width: 1280, quality: 0.55 },
      { width: 960, quality: 0.38 },
      { width: 768, quality: 0.24 },
    ]) {
      const scale = Math.min(1, variant.width / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return blob;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const candidate = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", variant.quality),
      );
      if (candidate && candidate.size <= 256 * 1024) return candidate;
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

function defaultWorkspacePanels(
  state?: WorkspaceViewState,
): WorkspacePanelState[] {
  if (state?.panels?.length) {
    if (state.panels.some((panel) => panel.kind === "changes"))
      return state.panels;
    const agentIndex = state.panels.findIndex(
      (panel) => panel.kind === "agent",
    );
    const next = [...state.panels];
    next.splice(agentIndex >= 0 ? agentIndex + 1 : 0, 0, {
      id: "changes",
      kind: "changes",
      title: "变更",
    });
    return next;
  }
  return [
    { id: "agent", kind: "agent", title: "智能体" },
    { id: "changes", kind: "changes", title: "变更" },
    { id: "terminal-1", kind: "terminal", title: "终端 1" },
    {
      id: "browser-1",
      kind: "browser",
      title: "浏览器 1",
      browserUrl: state?.browserUrl,
    },
    {
      id: "files-1",
      kind: "files",
      title: "文件 1",
      directoryPath: state?.directoryPath,
      fileDraft: state?.fileDraft,
    },
  ];
}

function initialPanelId(
  state: WorkspaceViewState,
  panels: readonly WorkspacePanelState[],
): string {
  return state.activePanelId &&
    panels.some((panel) => panel.id === state.activePanelId)
    ? state.activePanelId
    : (panels.find((panel) => panel.kind === state.activeTab)?.id ?? "agent");
}

export default function TaskRoute() {
  const params = useLocalSearchParams<{
    profileId: string;
    serverId: string;
    threadId: string;
    cwd?: string;
    title?: string;
  }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const {
    hydrated,
    activeProfile,
    profiles,
    runtime: appRuntime,
    setActiveProfile,
    markGatewayReauthorizationRequired,
    demo,
  } = useApp();
  const goBack = () => backOrReplace(router, profileHomeHref(params.profileId));
  const profileReady = activeProfile?.id === params.profileId;
  const invalidProfile =
    hydrated && !profiles.some((profile) => profile.id === params.profileId);
  const server = profileReady
    ? appRuntime.servers.find((item) => item.id === params.serverId)
    : undefined;
  const [task, setTask] = useState<TaskRuntime | null>(
    () =>
      taskRuntimeRegistry.get(
        params.profileId,
        params.serverId,
        params.threadId,
      ) ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panels, setPanels] = useState<WorkspacePanelState[]>(() =>
    defaultWorkspacePanels(),
  );
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const [activePanelId, setActivePanelId] = useState("agent");
  const [mountedPanelIds, setMountedPanelIds] = useState<Set<string>>(
    () => new Set(["agent"]),
  );
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [drawerThreads, setDrawerThreads] = useState<
    Record<string, ThreadSummary[]>
  >({});
  const drawerProjection = useRef(new ThreadListProjection());
  const [drawerReloadRevision, setDrawerReloadRevision] = useState(0);
  const [drawerThreadErrors, setDrawerThreadErrors] = useState<Record<string, string>>({});
  const [drawerWorkspaceOptions, setDrawerWorkspaceOptions] = useState<
    Record<string, WorkspaceOption[]>
  >({});
  const [drawerWorkspaceErrors, setDrawerWorkspaceErrors] = useState<
    Record<string, string>
  >({});
  const [dirtyFilePanelIds, setDirtyFilePanelIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [fileOpenRequests, setFileOpenRequests] = useState<
    Record<
      string,
      { path: string; revision: number; line?: number; column?: number }
    >
  >({});
  const fileOpenRevision = useRef(0);
  const fileDirty = dirtyFilePanelIds.size > 0;
  const [workspaceState, setWorkspaceState] = useState<WorkspaceViewState>({
    activeTab: "agent",
  });
  const [workspaceStateHydrated, setWorkspaceStateHydrated] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || !fileDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", beforeUnload);
    return () => globalThis.removeEventListener("beforeunload", beforeUnload);
  }, [fileDirty]);

  useEffect(() => {
    if (isFocused && task?.isDisposed()) setTask(null);
  }, [isFocused, task]);

  useEffect(() => {
    if (
      shouldActivateRouteProfile({
        focused: isFocused,
        hydrated,
        routeProfileId: params.profileId,
        activeProfileId: activeProfile?.id,
        profileIds: profiles.map((profile) => profile.id),
      })
    ) {
      void setActiveProfile(params.profileId);
    }
  }, [
    activeProfile?.id,
    hydrated,
    isFocused,
    params.profileId,
    profiles,
    setActiveProfile,
  ]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceStateHydrated(false);
    void loadWorkspaceState(params.profileId, params.serverId, params.threadId)
      .then((stored) => {
        if (cancelled) return;
        const restoredPanels = defaultWorkspacePanels(stored);
        const restoredPanelId = initialPanelId(stored, restoredPanels);
        setWorkspaceState(stored);
        panelsRef.current = restoredPanels;
        setPanels(restoredPanels);
        setActivePanelId(restoredPanelId);
        setMountedPanelIds((current) => new Set([...current, restoredPanelId]));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setWorkspaceStateHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [params.profileId, params.serverId, params.threadId]);

  const selectPanel = (panel: WorkspacePanelState) => {
    Keyboard.dismiss();
    setMountedPanelIds((current) => new Set([...current, panel.id]));
    setActivePanelId(panel.id);
    setWorkspaceState((current) => ({
      ...current,
      activeTab: panel.kind,
      activePanelId: panel.id,
      panels,
    }));
    void saveWorkspaceState(
      params.profileId,
      params.serverId,
      params.threadId,
      { activeTab: panel.kind, activePanelId: panel.id, panels },
    ).catch(() => {});
  };

  const persistWorkspaceState = useCallback(
    (update: Partial<WorkspaceViewState>) => {
      setWorkspaceState((current) => ({ ...current, ...update }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        update,
      ).catch(() => {});
    },
    [params.profileId, params.serverId, params.threadId],
  );
  const persistComposerDraft = useCallback(
    (composerDraft: string | undefined) =>
      persistWorkspaceState({ composerDraft }),
    [persistWorkspaceState],
  );
  const persistQueuedMessages = useCallback(
    (queuedMessages: WorkspaceViewState["queuedMessages"]) =>
      persistWorkspaceState({ queuedMessages }),
    [persistWorkspaceState],
  );
  const persistTurnPreferences = useCallback(
    (model: string, reasoningEffort?: string) =>
      persistWorkspaceState({ model, reasoningEffort }),
    [persistWorkspaceState],
  );
  const updatePanel = useCallback(
    (panelId: string, update: Partial<WorkspacePanelState>) => {
      let changed = false;
      const next = panelsRef.current.map((panel) => {
        if (panel.id !== panelId) return panel;
        if (
          Object.entries(update).every(([key, value]) =>
            Object.is(panel[key as keyof WorkspacePanelState], value),
          )
        )
          return panel;
        changed = true;
        return { ...panel, ...update, id: panel.id, kind: panel.kind };
      });
      if (!changed) return;
      panelsRef.current = next;
      setPanels(next);
      setWorkspaceState((state) => ({ ...state, panels: next }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        { panels: next },
      ).catch(() => {});
    },
    [params.profileId, params.serverId, params.threadId],
  );

  const addPanel = (kind: Exclude<WorkspaceTab, "agent">) => {
    if (panels.length >= 12) return;
    const count = panels.filter((panel) => panel.kind === kind).length + 1;
    const id = `${kind}-${Date.now().toString(36)}`;
    const label =
      kind === "changes"
        ? "变更"
        : kind === "terminal"
          ? "终端"
          : kind === "browser"
            ? "浏览器"
            : "文件";
    const nextPanel: WorkspacePanelState = {
      id,
      kind,
      title: `${label} ${count}`,
    };
    const next = [...panels, nextPanel];
    panelsRef.current = next;
    setPanels(next);
    setPanelMenuOpen(false);
    setMountedPanelIds((current) => new Set([...current, id]));
    setActivePanelId(id);
    setWorkspaceState((current) => ({
      ...current,
      activeTab: kind,
      activePanelId: id,
      panels: next,
    }));
    void saveWorkspaceState(
      params.profileId,
      params.serverId,
      params.threadId,
      { activeTab: kind, activePanelId: id, panels: next },
    ).catch(() => {});
  };

  const closePanel = (panelId: string) => {
    if (panelId === "agent" || panelId === "changes") return;
    const closingPanel = panels.find((panel) => panel.id === panelId);
    const close = () => {
      const index = panels.findIndex((panel) => panel.id === panelId);
      const next = panels.filter((panel) => panel.id !== panelId);
      const fallback =
        activePanelId === panelId
          ? (next[Math.max(0, Math.min(index - 1, next.length - 1))] ?? next[0])
          : next.find((panel) => panel.id === activePanelId);
      panelsRef.current = next;
      setPanels(next);
      setMountedPanelIds((current) => {
        const updated = new Set(current);
        updated.delete(panelId);
        return updated;
      });
      setDirtyFilePanelIds((current) => {
        const updated = new Set(current);
        updated.delete(panelId);
        return updated;
      });
      if (closingPanel?.kind === "terminal")
        task?.closeTerminalSession(panelId);
      if (fallback) setActivePanelId(fallback.id);
      setWorkspaceState((current) => ({
        ...current,
        activeTab: fallback?.kind ?? "agent",
        activePanelId: fallback?.id ?? "agent",
        panels: next,
      }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        {
          activeTab: fallback?.kind ?? "agent",
          activePanelId: fallback?.id ?? "agent",
          panels: next,
        },
      ).catch(() => {});
    };
    if (dirtyFilePanelIds.has(panelId)) {
      requestConfirmation({
        title: "关闭未保存的文件？",
        message: "这个文件标签中还有未保存的编辑。",
        confirmLabel: "放弃并关闭",
        destructive: true,
        onConfirm: close,
      });
      return;
    }
    if (
      closingPanel?.kind === "terminal" &&
      task?.isLiveTerminalSession(panelId)
    ) {
      requestConfirmation({
        title: "关闭终端？",
        message: "关闭会立即终止这个终端中正在运行的进程。",
        confirmLabel: "关闭终端",
        destructive: true,
        onConfirm: close,
      });
      return;
    }
    close();
  };

  const openWorkspaceFile = useCallback(
    (rawLink: string): boolean => {
      if (!task) return false;
      const location = workspaceFileLocationFromLink(
        rawLink,
        task.getSnapshot().cwd,
      );
      if (!location) return false;
      const { path } = location;
      let next = panelsRef.current;
      let panel = next.find(
        (candidate) =>
          candidate.kind === "files" && !dirtyFilePanelIds.has(candidate.id),
      );
      if (!panel) {
        if (next.length >= 12) {
          Alert.alert(
            "无法打开文件",
            "所有文件标签都有未保存内容，且工作区已达到 12 个标签上限。请先保存或关闭一个标签。",
          );
          return true;
        }
        panel = {
          id: `files-${Date.now().toString(36)}`,
          kind: "files",
          title: "文件",
        };
        next = [...next, panel];
      }
      const title = path.split("/").at(-1) || "文件";
      next = next.map((candidate) =>
        candidate.id === panel!.id ? { ...candidate, title } : candidate,
      );
      panel = next.find((candidate) => candidate.id === panel!.id)!;
      panelsRef.current = next;
      setPanels(next);
      setMountedPanelIds((current) => new Set([...current, panel!.id]));
      setActivePanelId(panel.id);
      setFileOpenRequests((current) => ({
        ...current,
        [panel!.id]: { ...location, revision: ++fileOpenRevision.current },
      }));
      const update = {
        activeTab: "files" as const,
        activePanelId: panel.id,
        panels: next,
      };
      setWorkspaceState((current) => ({ ...current, ...update }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        update,
      ).catch(() => {});
      Keyboard.dismiss();
      return true;
    },
    [
      dirtyFilePanelIds,
      params.profileId,
      params.serverId,
      params.threadId,
      task,
    ],
  );

  useEffect(() => {
    if (
      task ||
      !workspaceStateHydrated ||
      !profileReady ||
      !activeProfile ||
      !server
    )
      return;
    let cancelled = false;
    const load = async () => {
      try {
        const resumed = demo
          ? TaskRuntime.demo(params.threadId)
          : await TaskRuntime.resume({
              profile: activeProfile,
              server,
              threadId: params.threadId,
              cwd: params.cwd,
              title: params.title,
              reasoningEffort: workspaceState.reasoningEffort,
              onSessionExpired: () =>
                markGatewayReauthorizationRequired(activeProfile.id),
            });
        if (cancelled) {
          resumed.close();
          return;
        }
        taskRuntimeRegistry.put(activeProfile.id, server.id, resumed);
        setTask(resumed);
      } catch (value) {
        if (!cancelled) setLoadError(taskOpenError(value));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activeProfile,
    demo,
    markGatewayReauthorizationRequired,
    params.cwd,
    params.threadId,
    params.title,
    profileReady,
    server,
    task,
    workspaceState.reasoningEffort,
    workspaceStateHydrated,
  ]);

  useEffect(() => {
    if (!profileReady || !activeProfile || !server) return;
    if (demo) {
      setDrawerThreads({
        [server.id]: task
          ? [
              {
                id: task.getSnapshot().threadId,
                title: task.getSnapshot().title,
                status: "idle",
                cwd: task.getSnapshot().cwd,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ]
          : [],
      });
      setDrawerWorkspaceOptions({
        [server.id]: [
          {
            path: task?.getSnapshot().cwd ?? server.workspacePath ?? "/",
            label: "KCoder",
            kind: "workspace",
          },
        ],
      });
      setDrawerWorkspaceErrors({});
      return;
    }
    let cancelled = false;
    drawerProjection.current.retainScopes(appRuntime.servers.map((item) => threadListScopeKey(activeProfile, item, { archived: false })));
    const mutationRevision = drawerProjection.current.revision;
    setDrawerThreads(Object.fromEntries(appRuntime.servers.map((item) => [item.id, drawerProjection.current.get(threadListScopeKey(activeProfile, item, { archived: false }))?.threads ?? []])));
    setDrawerThreadErrors({});
    void Promise.all(
      appRuntime.servers.map(async (item) => {
        const [threadResult, workspaceResult] = await Promise.allSettled([
          listThreads(activeProfile, item, 100, { archived: false }),
          listWorkspaceOptions(activeProfile, item),
        ]);
        return [
          item.id,
          threadResult.status === "fulfilled"
            ? threadResult.value
            : undefined,
          workspaceResult.status === "fulfilled"
            ? workspaceResult.value
            : ([] as WorkspaceOption[]),
          workspaceResult.status === "rejected"
            ? workspaceResult.reason instanceof Error
              ? workspaceResult.reason.message
              : String(workspaceResult.reason)
            : null,
          threadResult.status === "rejected"
            ? threadResult.reason instanceof Error ? threadResult.reason.message : String(threadResult.reason)
            : threadListNotice(threadResult.value),
        ] as const;
      }),
    )
      .then((groups) => {
        if (cancelled || mutationRevision !== drawerProjection.current.revision) return;
        setDrawerThreads(
          Object.fromEntries(groups.map(([id, page]) => {
            const item = appRuntime.servers.find((candidate) => candidate.id === id)!;
            const scope = threadListScopeKey(activeProfile, item, { archived: false });
            return [id, (page ? drawerProjection.current.update(scope, page) : drawerProjection.current.get(scope))?.threads ?? []];
          })),
        );
        setDrawerThreadErrors(Object.fromEntries(groups.flatMap(([id, , , , error]) => error ? [[id, error]] : [])));
        setDrawerWorkspaceOptions(
          Object.fromEntries(groups.map(([id, , options]) => [id, options])),
        );
        setDrawerWorkspaceErrors(
          Object.fromEntries(
            groups.flatMap(([id, , , error]) => (error ? [[id, error]] : [])),
          ),
        );
      })
      .catch(() => {
        if (!cancelled && mutationRevision === drawerProjection.current.revision) {
          setDrawerThreadErrors(Object.fromEntries(appRuntime.servers.map((item) => [item.id, "会话列表加载失败，已保留此前会话，请重试。"])));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfile, appRuntime.servers, demo, profileReady, server, task, drawerReloadRevision]);

  useEffect(
    () => () => {
      if (task?.getSnapshot().archivedAt) {
        taskRuntimeRegistry.remove(
          params.profileId,
          params.serverId,
          params.threadId,
        );
      }
    },
    [params.profileId, params.serverId, params.threadId, task],
  );

  const routeError = invalidProfile
    ? "这个任务链接指向已移除的 Gateway。"
    : profileReady && !appRuntime.loading && !server
      ? "这个任务链接指向不存在或已移除的 KCoder 服务器。"
      : null;

  if (routeError || !task) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        {routeError || loadError ? (
          <EmptyState
            icon={<Bot size={44} color={colors.red} />}
            title="无法打开任务"
            body={routeError ?? loadError ?? "未知错误"}
          />
        ) : (
          <ActivityIndicator color={colors.text} />
        )}
        <Pressable onPress={goBack} style={styles.backTextButton}>
          <Text style={styles.backText}>返回任务列表</Text>
        </Pressable>
      </View>
    );
  }

  if (!workspaceStateHydrated) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={styles.loadingWorkspaceLabel}>正在恢复工作区…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <TaskHeader
        task={task}
        onBack={goBack}
        onMenu={() => setDrawerOpen(true)}
        onMore={() => setTaskMenuOpen(true)}
      />
      <WorkspaceTabSwitcher
        panels={panels}
        activePanelId={activePanelId}
        open={tabSwitcherOpen}
        onOpenChange={setTabSwitcherOpen}
        onSelect={selectPanel}
        onClose={closePanel}
        onAdd={() => setPanelMenuOpen(true)}
      />
      <RetainedPanel active={activePanelId === "agent"}>
        <AgentPanel
          task={task}
          profile={activeProfile ?? undefined}
          server={server}
          bottomInset={insets.bottom}
          demo={demo}
          initialDraft={workspaceState.composerDraft}
          initialQueuedMessages={workspaceState.queuedMessages}
          onDraftChange={persistComposerDraft}
          onQueuedMessagesChange={persistQueuedMessages}
          onTurnPreferencesChange={persistTurnPreferences}
          onOpenFile={openWorkspaceFile}
          onOpenChanges={() => {
            const changesPanel = panelsRef.current.find(
              (panel) => panel.kind === "changes",
            );
            if (changesPanel) selectPanel(changesPanel);
          }}
        />
      </RetainedPanel>
      {panels
        .filter(
          (panel) => panel.kind === "changes" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <ChangesPanel
              task={task}
              demo={demo}
              onOpenFile={openWorkspaceFile}
            />
          </RetainedPanel>
        ))}
      {panels
        .filter(
          (panel) => panel.kind === "terminal" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <TerminalPanel
              task={task}
              demo={demo}
              panelId={panel.id}
              initialSessionId={panel.terminalSessionId}
              onSessionIdChange={(terminalSessionId) =>
                updatePanel(panel.id, { terminalSessionId })
              }
              paneActive={isFocused && activePanelId === panel.id}
              onOpenFile={openWorkspaceFile}
            />
          </RetainedPanel>
        ))}
      {profileReady && activeProfile && server
        ? panels
            .filter(
              (panel) =>
                panel.kind === "browser" && mountedPanelIds.has(panel.id),
            )
            .map((panel) => (
              <RetainedPanel
                key={panel.id}
                active={activePanelId === panel.id}
                bottomInset={insets.bottom}
              >
                <BrowserPanel
                  profile={activeProfile}
                  server={server}
                  cwd={task.getSnapshot().cwd}
                  demo={demo}
                  active={isFocused && activePanelId === panel.id}
                  initialUrl={panel.browserUrl}
                  onUrlChange={(browserUrl) =>
                    updatePanel(panel.id, { browserUrl })
                  }
                />
              </RetainedPanel>
            ))
        : null}
      {panels
        .filter(
          (panel) => panel.kind === "files" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <FilesPanel
              task={task}
              demo={demo}
              initialDirectory={panel.directoryPath}
              initialDraft={panel.fileDraft}
              openFileRequest={fileOpenRequests[panel.id]}
              onDirtyChange={(dirty) =>
                setDirtyFilePanelIds((current) => {
                  if (current.has(panel.id) === dirty) return current;
                  const next = new Set(current);
                  if (dirty) next.add(panel.id);
                  else next.delete(panel.id);
                  return next;
                })
              }
              onDirectoryChange={(directoryPath) =>
                updatePanel(panel.id, { directoryPath })
              }
              onDraftChange={(fileDraft) =>
                updatePanel(panel.id, { fileDraft })
              }
            />
          </RetainedPanel>
        ))}
      {activeProfile ? (
        <MobileDrawer
          visible={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          profileId={params.profileId}
          profile={activeProfile}
          servers={appRuntime.servers}
          threads={demo ? drawerThreads : Object.fromEntries(appRuntime.servers.map((item) => [item.id, drawerProjection.current.get(threadListScopeKey(activeProfile, item, { archived: false }))?.threads ?? []]))}
          workspaceOptions={drawerWorkspaceOptions}
          workspaceErrors={drawerWorkspaceErrors}
          threadErrors={drawerThreadErrors}
          demo={demo}
          liveTask={task}
          liveTaskServerId={params.serverId}
          onThreadRenamed={(serverId, thread) => {
            const item = appRuntime.servers.find((candidate) => candidate.id === serverId);
            if (item) drawerProjection.current.changeThread(threadListScopeKey(activeProfile, item, { archived: false }), thread);
            setDrawerReloadRevision((value) => value + 1);
            setDrawerThreads((current) => ({
              ...current,
              [serverId]: (current[serverId] ?? []).map((candidate) =>
                candidate.id === thread.id ? thread : candidate,
              ),
            }));
          }}
          onThreadRemoved={(serverId, threadId) => {
            const item = appRuntime.servers.find((candidate) => candidate.id === serverId);
            if (item) drawerProjection.current.removeThread(threadListScopeKey(activeProfile, item, { archived: false }), threadId);
            setDrawerReloadRevision((value) => value + 1);
            setDrawerThreads((current) => ({
              ...current,
              [serverId]: (current[serverId] ?? []).filter(
                (thread) => thread.id !== threadId,
              ),
            }));
            if (serverId === params.serverId && threadId === params.threadId)
              router.replace({
                pathname: "/h/[profileId]",
                params: { profileId: params.profileId },
              });
          }}
        />
      ) : null}
      <TaskMenu
        visible={taskMenuOpen}
        task={task}
        demo={demo}
        onClose={() => setTaskMenuOpen(false)}
        onArchived={() => {
          taskRuntimeRegistry.remove(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          router.replace({
            pathname: "/h/[profileId]",
            params: { profileId: params.profileId },
          });
        }}
        onDeleted={async () => {
          if (!demo) {
            for (const message of workspaceState.queuedMessages ?? []) {
              for (const attachment of message.attachments)
                await task
                  .request("attachment/delete", { path: attachment.path })
                  .catch(() => {});
            }
          }
          await removeWorkspaceState(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          taskRuntimeRegistry.remove(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          router.replace({
            pathname: "/h/[profileId]",
            params: { profileId: params.profileId },
          });
        }}
      />
      <PanelMenu
        visible={panelMenuOpen}
        canAdd={panels.length < 12}
        onClose={() => setPanelMenuOpen(false)}
        onAdd={addPanel}
      />
    </KeyboardAvoidingView>
  );
}

function RetainedPanel({
  active,
  bottomInset = 0,
  children,
}: {
  active: boolean;
  bottomInset?: number;
  children: React.ReactNode;
}) {
  return (
    <View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={[
        styles.retainedPanel,
        !active && styles.hiddenPanel,
        bottomInset > 0 && { paddingBottom: bottomInset },
      ]}
    >
      {children}
    </View>
  );
}

function TaskHeader({
  task,
  onBack,
  onMenu,
  onMore,
}: {
  task: TaskRuntime;
  onBack(): void;
  onMenu(): void;
  onMore(): void;
}) {
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel="返回"
        onPress={onBack}
        style={styles.headerButton}
      >
        <ChevronLeft size={23} color={colors.text} />
      </Pressable>
      <Pressable
        accessibilityLabel="打开任务列表"
        onPress={onMenu}
        style={styles.headerButton}
      >
        <PanelLeft size={19} color={colors.textMuted} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {snapshot.title}
        </Text>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              snapshot.connected ? styles.online : styles.offline,
            ]}
          />
          <Text style={styles.statusText}>
            {snapshot.running
              ? "KCoder 正在工作"
              : snapshot.connected
                ? snapshot.cwd
                : "连接已断开"}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityLabel="更多"
        onPress={onMore}
        style={styles.headerButton}
      >
        <MoreHorizontal size={22} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

function TaskMenu({
  visible,
  task,
  demo,
  onClose,
  onArchived,
  onDeleted,
}: {
  visible: boolean;
  task: TaskRuntime;
  demo: boolean;
  onClose(): void;
  onArchived(): void;
  onDeleted(): void | Promise<void>;
}) {
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  const [title, setTitle] = useState(snapshot.title);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const modalRef = useModalFocusTrap(visible, onClose);
  useEffect(() => {
    if (!visible) return;
    setTitle(snapshot.title);
    setMessage(null);
  }, [snapshot.title, visible]);
  const run = async <T,>(
    action: () => Promise<T>,
    success: string | ((result: T) => string),
    close = false,
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage(typeof success === "function" ? success(result) : success);
      if (close) onClose();
    } catch (value) {
      setMessage(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const runningOrBusy = busy || snapshot.running;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      accessibilityLabel="任务操作"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.taskMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>任务操作</Text>
          <Pressable
            accessibilityLabel="关闭"
            onPress={onClose}
            style={styles.modalClose}
          >
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="任务标题"
          editable={!busy}
          accessibilityState={{ disabled: busy }}
          value={title}
          onChangeText={setTitle}
          style={[styles.taskTitleInput, busy && styles.sendDisabled]}
        />
        <Pressable
          testID="rename-task"
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          onPress={() => void run(() => task.rename(title), "标题已更新")}
          style={[styles.taskMenuRow, busy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>重命名</Text>
        </Pressable>
        <Pressable
          testID="compact-task"
          disabled={runningOrBusy}
          accessibilityState={{ disabled: runningOrBusy }}
          onPress={() =>
            void run(
              () => task.compact(),
              (result) =>
                result.compacted
                  ? `上下文已压缩（${result.preTokens} → ${result.postTokens} tokens）`
                  : "当前上下文无需压缩",
            )
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>压缩上下文</Text>
        </Pressable>
        {snapshot.archivedAt ? (
          <Pressable
            testID="unarchive-task-menu"
            disabled={busy}
            accessibilityState={{ disabled: busy }}
            onPress={() => void run(() => task.unarchive(), "任务已恢复")}
            style={[styles.taskMenuRow, busy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>恢复任务</Text>
          </Pressable>
        ) : (
          <Pressable
            testID="archive-task-menu"
            disabled={runningOrBusy}
            accessibilityState={{ disabled: runningOrBusy }}
            onPress={() =>
              requestConfirmation({
                title: "归档此任务？",
                message:
                  "任务将从最近列表移到已归档任务，并释放当前运行连接；之后仍可恢复查看。",
                confirmLabel: "归档",
                onConfirm: () =>
                  void run(async () => {
                    await task.archive();
                    onArchived();
                  }, "任务已归档"),
              })
            }
            style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>
              {snapshot.running ? "任务运行中，暂不能归档" : "归档任务"}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="delete-task"
          disabled={runningOrBusy}
          accessibilityState={{ disabled: runningOrBusy }}
          onPress={() =>
            requestConfirmation({
              title: "永久删除此任务？",
              message:
                "任务历史和本机保存的工作区界面状态都将被删除，此操作无法撤销。",
              confirmLabel: "永久删除",
              destructive: true,
              onConfirm: () =>
                void run(async () => {
                  await task.deleteThread();
                  await onDeleted();
                }, "任务已删除"),
            })
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuDanger}>删除任务</Text>
        </Pressable>
        {busy ? <ActivityIndicator color={colors.textMuted} /> : null}
        {message ? <Text style={styles.taskMenuMessage}>{message}</Text> : null}
      </View>
    </Modal>
  );
}

function AgentPanel({
  task,
  profile,
  server,
  bottomInset,
  demo,
  initialDraft,
  initialQueuedMessages,
  onDraftChange,
  onQueuedMessagesChange,
  onTurnPreferencesChange,
  onOpenFile,
  onOpenChanges,
}: {
  task: TaskRuntime;
  profile?: GatewayProfile;
  server?: KCoderServer;
  bottomInset: number;
  demo: boolean;
  initialDraft?: string;
  initialQueuedMessages?: WorkspaceViewState["queuedMessages"];
  onDraftChange?(value: string | undefined): void;
  onQueuedMessagesChange?(value: WorkspaceViewState["queuedMessages"]): void;
  onTurnPreferencesChange?(model: string, reasoningEffort?: string): void;
  onOpenFile(link: string): boolean;
  onOpenChanges(): void;
}) {
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  const messageQueue = useMemo(() => taskMessageQueue(task), [task]);
  const queuedMessages = useSyncExternalStore(
    messageQueue.subscribe,
    messageQueue.getSnapshot,
    messageQueue.getSnapshot,
  );
  const [input, setInput] = useState("");
  const messageInputRef = useRef<TextInput>(null);
  const goalEditExpectationRef = useRef<{
    command: "/goal" | "/goal-pro" | "/ultgoal";
    goalId: string;
    revision: number;
  } | null>(null);
  const [attachments, setAttachments] = useState<ComposerStagedAttachment[]>(
    [],
  );
  const stagedAttachmentsRef = useRef<ComposerStagedAttachment[]>([]);
  const mountedRef = useRef(true);
  const mountGeneration = useRef(0);
  stagedAttachmentsRef.current = attachments;
  const [attachmentSheet, setAttachmentSheet] = useState(false);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const attachmentBatchRunning = useRef(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const sendingQueued = useRef(false);
  const queueHydrated = useRef(false);
  const lastQueuePersistence = useRef<string | null>(null);
  const closeAttachmentSheet = () => {
    if (!attachmentLoading) setAttachmentSheet(false);
  };
  const openAttachmentSheet = () => {
    Keyboard.dismiss();
    setAttachmentError(null);
    setAttachmentSheet(true);
  };
  const attachmentSheetRef = useModalFocusTrap(
    attachmentSheet,
    closeAttachmentSheet,
  );
  const closeModelPicker = () => {
    if (!modelBusy) setModelPickerOpen(false);
  };
  const modelPickerRef = useModalFocusTrap(modelPickerOpen, closeModelPicker);
  useEffect(() => {
    const generation = ++mountGeneration.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (demo) return;
      const abandoned = [...stagedAttachmentsRef.current];
      queueMicrotask(() => {
        if (mountedRef.current || mountGeneration.current !== generation)
          return;
        for (const attachment of abandoned) {
          releaseLocalAttachmentPreview(attachment);
          void task
            .request("attachment/delete", { path: attachment.path })
            .catch(() => {});
        }
      });
    };
  }, [demo, task]);
  const messageListRef = useRef<FlatList<ChatMessage>>(null);
  const messageListLayoutHeight = useRef(0);
  const messageFollowState = useRef(initialMessageFollowState());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const webPrependAnchor = useRef<{
    scroller: HTMLElement;
    height: number;
    top: number;
    applying: boolean;
    adjusting: boolean;
  } | null>(null);
  const draftHydrated = useRef(false);
  useEffect(() => {
    if (draftHydrated.current || initialDraft === undefined) return;
    draftHydrated.current = true;
    setInput((current) => current || initialDraft);
  }, [initialDraft]);
  useEffect(() => {
    const timer = setTimeout(() => onDraftChange?.(input || undefined), 350);
    return () => clearTimeout(timer);
  }, [input, onDraftChange]);
  useEffect(() => {
    if (
      !queueHydrated.current &&
      messageQueue.getSnapshot().length === 0 &&
      initialQueuedMessages?.length
    ) {
      messageQueue.replace(initialQueuedMessages);
      return;
    }
    queueHydrated.current = true;
    const signature = JSON.stringify(queuedMessages);
    if (lastQueuePersistence.current === signature) return;
    lastQueuePersistence.current = signature;
    onQueuedMessagesChange?.(
      queuedMessages.length > 0
        ? queuedMessages.map((message) => ({
            ...message,
            attachments: [...message.attachments],
          }))
        : undefined,
    );
  }, [
    initialQueuedMessages,
    messageQueue,
    onQueuedMessagesChange,
    queuedMessages,
  ]);
  const latestInputRef = useRef(input);
  const onDraftChangeRef = useRef(onDraftChange);
  latestInputRef.current = input;
  onDraftChangeRef.current = onDraftChange;
  useEffect(
    () => () => {
      onDraftChangeRef.current?.(latestInputRef.current || undefined);
    },
    [],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        onDraftChange?.(latestInputRef.current || undefined);
    });
    return () => subscription.remove();
  }, [onDraftChange]);
  useEffect(() => {
    if (!shouldAnchorLatest(messageFollowState.current)) return;
    const timer = setTimeout(
      () => messageListRef.current?.scrollToEnd({ animated: false }),
      90,
    );
    return () => clearTimeout(timer);
  }, [snapshot.messages.at(-1)?.id, snapshot.messages.at(-1)?.content]);

  const slashCommands = useMemo(
    () => filterMobileSlashCommands(input),
    [input],
  );

  const executeSlashCommand = async (rawValue: string): Promise<boolean> => {
    const parsed = parseMobileSlashCommand(rawValue);
    if (!parsed) {
      if (!isMobileSlashCommandInput(rawValue)) return false;
      const command = rawValue.trim().split(/\s+/, 1)[0];
      setQueueError(
        command === "/"
          ? "请输入 slash 指令名称"
          : `未知 slash 指令：${command}`,
      );
      return true;
    }
    if (attachments.length > 0) {
      setQueueError("Slash 指令不能同时携带附件");
      return true;
    }
    setQueueError(null);
    setComposerNotice(null);
    const { command, args } = parsed;
    const isGoalCommand =
      command.name === "/goal" ||
      command.name === "/goal-pro" ||
      command.name === "/ultgoal";
    if (command.acceptsArguments && !args && !isGoalCommand && command.name !== '/moa') {
      setQueueError(`用法：${command.name} <内容>`);
      return true;
    }
    if (!command.acceptsArguments && args) {
      setQueueError(`用法：${command.name}`);
      return true;
    }
    try {
      if (command.name === '/moa' || command.name === '/moa-plan') {
        if (!args) {
          const modes = await task.request<{moaSummary: string}>('session/modes', {threadId: snapshot.threadId});
          setComposerNotice(modes.moaSummary);
        } else if (snapshot.running || snapshot.interaction) {
          messageQueue.enqueue({id: `mode-${Date.now()}`, content: `${command.name} ${args}`, attachments: [], createdAt: Date.now()});
        } else {
          await task.send(args, [], command.name === '/moa' ? 'moa' : 'moa-plan');
        }
        setInput('');
        return true;
      }
      if (command.name === "/model") {
        setInput("");
        openModelPicker();
        return true;
      }
      if (command.name === "/compact") {
        const result = await task.compact();
        setInput("");
        setComposerNotice(
          result.compacted
            ? `上下文已压缩（${result.preTokens} → ${result.postTokens} tokens）`
            : "当前上下文无需压缩",
        );
        return true;
      }
      if (command.name === "/rename") {
        await task.rename(args);
        setInput("");
        setComposerNotice("任务标题已更新");
        return true;
      }
      const mode =
        command.name === "/goal-pro"
          ? "strict"
          : command.name === "/ultgoal"
            ? "arrangement"
            : "standard";
      const action = parseMobileGoalSlashAction(command.name, args);
      if (action.kind !== "edit") goalEditExpectationRef.current = null;
      if (action.kind === "status") {
        setComposerNotice(goalStatusNotice(await task.getGoal()));
      } else if (action.kind === "history") {
        setComposerNotice(goalHistoryNotice(await task.getGoalHistory(), mode));
      } else if (action.kind === "pause" || action.kind === "resume") {
        if (action.kind === "resume") {
          const current = await task.getGoal();
          if (!current) throw new Error("当前没有目标");
          if (current.status === "active") {
            setComposerNotice(goalStatusNotice(current));
            setInput("");
            return true;
          }
          if (current.status !== "paused" && current.status !== "blocked") {
            throw new Error(
              `状态为 ${current.status} 的目标不能恢复，请先 clear`,
            );
          }
        }
        const goal = await task.updateGoalStatus(
          action.kind === "pause" ? "paused" : "active",
        );
        setComposerNotice(goalStatusNotice(goal));
      } else if (action.kind === "clear") {
        setComposerNotice(
          (await task.clearGoal()) ? `${command.name} 已清除` : "当前没有目标",
        );
      } else if (action.kind === "edit") {
        if (!action.objective) {
          const goal = await task.getGoal();
          if (!goal) throw new Error("当前没有目标");
          goalEditExpectationRef.current = {
            command: command.name,
            goalId: goal.goalId,
            revision: goal.revision,
          };
          setInput(`${command.name} edit ${goal.objective}`);
          setComposerNotice("目标已载入输入框，修改后发送即可保存");
          requestAnimationFrame(() => messageInputRef.current?.focus());
          return true;
        }
        const expectation =
          goalEditExpectationRef.current?.command === command.name
            ? goalEditExpectationRef.current
            : undefined;
        const goal = await task.editGoal(
          action.objective,
          action.tokenBudget,
          expectation,
        );
        goalEditExpectationRef.current = null;
        setInput("");
        setComposerNotice(`${goalLabel(goal)} 已更新并暂停`);
        onDraftChange?.(undefined);
      } else if (action.kind === "create") {
        const existing = await task.getGoal();
        const startGoal = async () => {
          await task.setGoal(action.objective, mode, {
            tokenBudget: action.tokenBudget,
            verificationKind: action.verificationKind,
            expectedGoal: existing ?? undefined,
            requireNoGoal: !existing,
          });
          setInput("");
          await task.send(action.objective);
          setComposerNotice(`${command.name} 已启动`);
          onDraftChange?.(undefined);
        };
        if (existing && goalIsUnfinished(existing)) {
          requestConfirmation({
            title: `替换当前 ${goalLabel(existing)}？`,
            message: "当前目标尚未结束。确认后会替换旧目标，并开始执行新目标。",
            confirmLabel: "替换目标",
            destructive: true,
            onConfirm: () =>
              void startGoal().catch((value) => {
                setQueueError(
                  value instanceof Error ? value.message : String(value),
                );
              }),
          });
          return true;
        }
        await startGoal();
      }
      if (action.kind !== "edit") setInput("");
      return true;
    } catch (value) {
      setQueueError(value instanceof Error ? value.message : String(value));
      return true;
    }
  };

  const selectSlashCommand = (command: MobileSlashCommand) => {
    if (command.acceptsArguments) {
      setInput(`${command.name} `);
      requestAnimationFrame(() => messageInputRef.current?.focus());
      return;
    }
    void executeSlashCommand(command.name);
  };

  const submit = async () => {
    const value = input.trim();
    if ((!value && attachments.length === 0) || !snapshot.connected) return;
    if (await executeSlashCommand(value)) return;
    goalEditExpectationRef.current = null;
    if (value.length > MAX_TASK_MESSAGE_CHARACTERS) {
      setQueueError(
        `消息不能超过 ${MAX_TASK_MESSAGE_CHARACTERS.toLocaleString()} 个字符`,
      );
      return;
    }
    if (
      (snapshot.running || snapshot.interaction) &&
      queuedMessages.length >= MAX_QUEUED_TASK_MESSAGES
    ) {
      setQueueError(
        `最多排队 ${MAX_QUEUED_TASK_MESSAGES} 条消息，请先移除一条或等待发送`,
      );
      return;
    }
    const outgoing = attachments;
    const wireOutgoing = outgoing.map(wireAttachment);
    if (snapshot.running || snapshot.interaction) {
      try {
        if (!demo && wireOutgoing.length > 0) {
          await task.request("gateway/attachments/retain", {
            paths: wireOutgoing.map((attachment) => attachment.path),
          });
        }
        messageQueue.enqueue({
          id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content: value,
          attachments: wireOutgoing,
          createdAt: Date.now(),
        });
      } catch (error) {
        setQueueError(
          `排队消息保存失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      setInput("");
      setAttachments([]);
      outgoing.forEach(releaseLocalAttachmentPreview);
      setQueueError(null);
      onDraftChange?.(undefined);
      return;
    }
    setInput("");
    setAttachments([]);
    try {
      await task.send(value, wireOutgoing);
      outgoing.forEach(releaseLocalAttachmentPreview);
      onDraftChange?.(undefined);
    } catch {
      if (!mountedRef.current) {
        outgoing.forEach(releaseLocalAttachmentPreview);
        if (!demo) {
          for (const attachment of wireOutgoing) {
            void task
              .request("attachment/delete", { path: attachment.path })
              .catch(() => {});
          }
        }
        return;
      }
      setInput((current) => current || value);
      setAttachments((current) => [
        ...outgoing.filter(
          (item) => !current.some((existing) => existing.path === item.path),
        ),
        ...current,
      ]);
    }
  };
  const canSend =
    snapshot.connected && (Boolean(input.trim()) || attachments.length > 0);

  useEffect(() => {
    if (
      !snapshot.connected ||
      snapshot.running ||
      snapshot.interaction ||
      snapshot.archivedAt ||
      sendingQueued.current ||
      queuedMessages.length === 0
    )
      return;
    const next = messageQueue.first();
    if (!next) return;
    sendingQueued.current = true;
    setQueueError(null);
    void task
      .send(next.content, next.attachments)
      .then(() => {
        messageQueue.remove(next.id);
      })
      .catch((value) => {
        setQueueError(
          `排队消息发送失败：${value instanceof Error ? value.message : String(value)}`,
        );
      })
      .finally(() => {
        sendingQueued.current = false;
      });
  }, [
    messageQueue,
    queuedMessages,
    snapshot.archivedAt,
    snapshot.connected,
    snapshot.interaction,
    snapshot.running,
    task,
  ]);

  const removeQueuedMessage = (id: string) => {
    const removed = messageQueue.remove(id);
    if (!removed || demo) return;
    for (const attachment of removed.attachments) {
      void task
        .request("attachment/delete", { path: attachment.path })
        .catch(() => {});
    }
  };

  const compensateWebPrepend = () => {
    const anchor = webPrependAnchor.current;
    if (!anchor?.applying || !anchor.scroller.isConnected) return false;
    const nextHeight = anchor.scroller.scrollHeight;
    const delta = nextHeight - anchor.height;
    if (delta === 0) return false;
    anchor.adjusting = true;
    anchor.top += delta;
    anchor.height = nextHeight;
    anchor.scroller.scrollTop = anchor.top;
    requestAnimationFrame(() => {
      if (webPrependAnchor.current === anchor) anchor.adjusting = false;
    });
    return true;
  };

  const loadOlder = async () => {
    messageFollowState.current = stopFollowingLatest();
    const webScroller =
      Platform.OS === "web"
        ? (messageListRef.current?.getNativeScrollRef() as unknown as
            HTMLElement | undefined)
        : undefined;
    if (webScroller)
      webPrependAnchor.current = {
        scroller: webScroller,
        height: webScroller.scrollHeight,
        top: webScroller.scrollTop,
        applying: false,
        adjusting: false,
      };
    await task.loadOlderMessages();
    const anchor = webPrependAnchor.current;
    if (!anchor || anchor.scroller !== webScroller || !webScroller?.isConnected)
      return;
    anchor.applying = true;
    let stableFrames = 0;
    const settle = () => {
      if (webPrependAnchor.current !== anchor) return;
      stableFrames = compensateWebPrepend() ? 0 : stableFrames + 1;
      if (stableFrames >= 4) {
        webPrependAnchor.current = null;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  const handleMessageListLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (Math.abs(nextHeight - messageListLayoutHeight.current) < 1) return;
    messageListLayoutHeight.current = nextHeight;
    const followedLatestBeforeResize = shouldAnchorLatest(
      messageFollowState.current,
    );
    requestAnimationFrame(() => {
      if (followedLatestBeforeResize) {
        messageFollowState.current = {
          ...messageFollowState.current,
          followsLatest: true,
        };
        setShowJumpToLatest(false);
        messageListRef.current?.scrollToEnd({ animated: false });
        return;
      }
      const scroller =
        Platform.OS === "web"
          ? (messageListRef.current?.getNativeScrollRef() as unknown as
              HTMLElement | undefined)
          : undefined;
      if (scroller) {
        const distance =
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        setShowJumpToLatest(distance >= 96);
      } else {
        setShowJumpToLatest(true);
      }
    });
  };

  const stageOne = async (asset: AttachmentAsset, selectedCount: number) => {
    if (selectedCount >= MAX_ATTACHMENTS_PER_TURN)
      throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
    let filename = asset.name || `attachment-${Date.now()}`;
    let mimeType = asset.mimeType || "application/octet-stream";
    let sourceUri = asset.uri;
    let localFile = Platform.OS === "web" ? null : new ExpoFile(sourceUri);
    let webBlob =
      Platform.OS === "web"
        ? (asset.blob ??
          (asset.base64
            ? webBase64Blob(asset.base64, mimeType)
            : await (await fetch(sourceUri)).blob()))
        : null;
    let fileSize = asset.size ?? webBlob?.size ?? localFile?.size ?? 0;
    if (
      Platform.OS === "web" &&
      webBlob &&
      fileSize > 256 * 1024 &&
      previewableRasterMimeType(mimeType) &&
      mimeType !== "image/gif"
    ) {
      const originalBlob = webBlob;
      webBlob = await compressWebImage(originalBlob);
      fileSize = webBlob.size;
      if (webBlob !== originalBlob) {
        mimeType = "image/jpeg";
        filename = `${filename.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
      }
    }
    if (
      Platform.OS !== "web" &&
      fileSize > 256 * 1024 &&
      previewableRasterMimeType(mimeType) &&
      mimeType !== "image/gif"
    ) {
      const variants = [
        { width: 1600, quality: 0.72 },
        { width: 1280, quality: 0.55 },
        { width: 960, quality: 0.38 },
        { width: 768, quality: 0.24 },
      ];
      for (const variant of variants) {
        const compressed = await manipulateAsync(
          sourceUri,
          [{ resize: { width: variant.width } }],
          { compress: variant.quality, format: SaveFormat.JPEG },
        );
        const candidate = new ExpoFile(compressed.uri);
        sourceUri = compressed.uri;
        localFile = candidate;
        fileSize = candidate.size ?? 0;
        mimeType = "image/jpeg";
        filename = `${filename.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
        if (fileSize <= 256 * 1024) break;
      }
    }
    if (fileSize > MAX_ATTACHMENT_BYTES)
      throw new Error("单个附件不能超过 50 MiB");
    let path = `/demo/attachments/${filename}`;
    if (!demo) {
      const readBase64Chunk =
        Platform.OS === "web"
          ? async (offset: number, length: number) =>
              webBlobBase64(
                (webBlob ?? new Blob()).slice(offset, offset + length),
              )
          : async (offset: number, length: number) =>
              readAsStringAsync(sourceUri, {
                encoding: EncodingType.Base64,
                position: offset,
                length,
              });
      path = await uploadStagedAttachment(
        task.request.bind(task),
        filename,
        fileSize,
        readBase64Chunk,
      );
      if (!mountedRef.current) {
        await task.request("attachment/delete", { path }).catch(() => {});
        return;
      }
    }
    const previewMime = previewableRasterMimeType(mimeType);
    const localPreviewUri = previewMime
      ? Platform.OS === "web" && webBlob && globalThis.URL?.createObjectURL
        ? globalThis.URL.createObjectURL(webBlob)
        : sourceUri
      : undefined;
    setAttachments((current) => [
      ...current,
      {
        filename,
        mimeType,
        fileSize,
        path,
        localPreviewUri,
        ownsLocalPreviewUri: Boolean(localPreviewUri && Platform.OS === "web"),
      },
    ]);
  };

  const runAttachmentSelection = async (
    select: () => Promise<AttachmentAsset[]>,
  ) => {
    if (attachmentBatchRunning.current) return;
    attachmentBatchRunning.current = true;
    setAttachmentLoading(true);
    setAttachmentError(null);
    const failures: string[] = [];
    try {
      const assets = await select();
      if (assets.length === 0) return;
      for (const [index, asset] of assets.entries()) {
        try {
          await stageOne(asset, attachments.length + index);
        } catch (value) {
          failures.push(
            `${asset.name}：${value instanceof Error ? value.message : String(value)}`,
          );
        }
      }
      if (!mountedRef.current) return;
      if (failures.length > 0)
        setAttachmentError(`以下附件未能添加：\n${failures.join("\n")}`);
      else setAttachmentSheet(false);
    } catch (value) {
      if (mountedRef.current)
        setAttachmentError(
          value instanceof Error ? value.message : String(value),
        );
    } finally {
      attachmentBatchRunning.current = false;
      if (mountedRef.current) setAttachmentLoading(false);
    }
  };

  const pickFile = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      return (result.assets ?? [])
        .slice(0, slots)
        .map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          blob: asset.file,
        }));
    });
  };

  const pickImage = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        base64: Platform.OS === "web",
        allowsMultipleSelection: true,
        selectionLimit: slots,
      });
      return (result.assets ?? [])
        .slice(0, slots)
        .map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName ?? `image-${Date.now()}-${index + 1}.jpg`,
          mimeType: asset.mimeType,
          size: asset.fileSize,
          base64: asset.base64,
        }));
    });
  };

  const takePhoto = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error("需要相机权限才能拍照；也可以从照片图库选择图片。");
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        base64: Platform.OS === "web",
      });
      const asset = result.assets?.[0];
      return asset
        ? [
            {
              uri: asset.uri,
              name: asset.fileName ?? `camera-${Date.now()}.jpg`,
              mimeType: asset.mimeType,
              size: asset.fileSize,
              base64: asset.base64,
            },
          ]
        : [];
    });
  };

  const removeAttachment = async (attachment: StagedAttachment) => {
    setAttachmentError(null);
    try {
      if (!demo)
        await task.request("attachment/delete", { path: attachment.path });
      releaseLocalAttachmentPreview(attachment);
      setAttachments((current) =>
        current.filter((item) => item.path !== attachment.path),
      );
    } catch (value) {
      setAttachmentError(
        `无法移除 ${attachment.filename}：${value instanceof Error ? value.message : String(value)}`,
      );
    }
  };

  function openModelPicker() {
    Keyboard.dismiss();
    setModelPickerOpen(true);
    setModelError(null);
    if (modelOptions.length > 0 || modelsLoading) return;
    setModelsLoading(true);
    const operation = demo
      ? Promise.resolve<ModelOption[]>([
          {
            id: "demo-minimax",
            model: "MiniMax-M3",
            displayName: "MiniMax-M3",
            providerId: "kunlunmeta",
            providerName: "KCoder Meta",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
          {
            id: "demo-kimi",
            model: "kimi-for-coding",
            displayName: "Kimi for Coding",
            providerId: "kimi",
            providerName: "Kimi",
            supportedReasoningEfforts: ["medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ])
      : profile && server
        ? listModels(profile, server)
        : Promise.reject(new Error("Gateway 或服务器尚未就绪"));
    void operation
      .then(setModelOptions)
      .catch((value) =>
        setModelError(value instanceof Error ? value.message : String(value)),
      )
      .finally(() => setModelsLoading(false));
  }

  const applyTurnPreferences = async (
    model: string,
    reasoningEffort?: string,
  ) => {
    if (modelBusy) return;
    setModelBusy(true);
    setModelError(null);
    try {
      await task.setTurnPreferences(model, reasoningEffort);
      onTurnPreferencesChange?.(model, reasoningEffort);
    } catch (value) {
      setModelError(value instanceof Error ? value.message : String(value));
    } finally {
      setModelBusy(false);
    }
  };
  const selectedModelOption = findSelectedModelOption(modelOptions, snapshot.model);

  return (
    <View style={styles.panel}>
      <View onLayout={handleMessageListLayout} style={styles.messageListStage}>
        <FlatList
          ref={messageListRef}
          testID="message-list"
          data={snapshot.messages}
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              task={task}
              onOpenFile={onOpenFile}
              onOpenChanges={onOpenChanges}
            />
          )}
          keyExtractor={(message) => message.id}
          style={styles.messages}
          contentContainerStyle={styles.messageContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== "web"}
          maintainVisibleContentPosition={
            Platform.OS === "web" ? undefined : { minIndexForVisible: 0 }
          }
          onScroll={({ nativeEvent }) => {
            const distance =
              nativeEvent.contentSize.height -
              nativeEvent.layoutMeasurement.height -
              nativeEvent.contentOffset.y;
            messageFollowState.current = observeMessageListDistance(
              messageFollowState.current,
              distance,
            );
            const shouldShow = !messageFollowState.current.followsLatest;
            setShowJumpToLatest((current) =>
              current === shouldShow ? current : shouldShow,
            );
            const anchor = webPrependAnchor.current;
            if (anchor && !anchor.adjusting) {
              anchor.top = nativeEvent.contentOffset.y;
              anchor.height = anchor.scroller.scrollHeight;
            }
          }}
          onScrollBeginDrag={() => {
            // User gestures take precedence over smooth return-to-latest scrolling. Otherwise
            // the programmatic lock could treat a gesture away from the bottom as an unfinished animation and pull back again.
            messageFollowState.current = stopFollowingLatest();
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            compensateWebPrepend();
            if (shouldAnchorLatest(messageFollowState.current))
              messageListRef.current?.scrollToEnd({ animated: false });
          }}
          ListHeaderComponent={
            snapshot.hasMoreBefore ? (
              <Pressable
                testID="load-older-messages"
                accessibilityRole="button"
                disabled={snapshot.loadingOlder}
                onPress={() => void loadOlder()}
                style={styles.historyButton}
              >
                {snapshot.loadingOlder ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Text style={styles.historyButtonText}>载入更早消息</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon={<Bot size={44} color={colors.textDim} />}
              title="开始对话"
              body="告诉 KCoder 你想在当前工作区完成什么。"
            />
          }
          ListFooterComponent={
            <>
              {snapshot.running &&
              !snapshot.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.turnId === snapshot.activeTurnId,
              ) ? (
                <View style={styles.thinkingRow}>
                  <ActivityIndicator size="small" color={colors.textMuted} />
                  <Text style={styles.thinkingLabel}>KCoder 正在思考…</Text>
                </View>
              ) : null}
              {snapshot.error ? (
                <RuntimeErrorBanner
                  key={snapshot.error}
                  error={snapshot.error}
                />
              ) : null}
            </>
          }
        />
        {showJumpToLatest ? (
          <Pressable
            testID="jump-to-latest"
            accessibilityRole="button"
            accessibilityLabel="回到最新消息"
            onPress={() => {
              messageFollowState.current = beginProgrammaticFollow();
              setShowJumpToLatest(false);
              messageListRef.current?.scrollToEnd({ animated: true });
            }}
            style={styles.jumpToLatest}
          >
            <ArrowDown size={16} color={colors.text} />
            <Text style={styles.jumpToLatestText}>最新</Text>
          </Pressable>
        ) : null}
      </View>
      {!snapshot.connected ? (
        <View accessibilityRole="alert" style={styles.connectionBanner}>
          <ActivityIndicator size="small" color={colors.yellow} />
          <Text style={styles.connectionBannerText}>
            连接已断开，正在自动重连；恢复后会同步服务器上的最新状态。
          </Text>
        </View>
      ) : null}
      {snapshot.interaction?.kind === "approval" ? (
        <ApprovalCard
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onRespond={(decision) => task.respondApproval(decision)}
        />
      ) : null}
      {snapshot.interaction?.kind === "question" ? (
        <QuestionCard
          key={snapshot.interaction.requestId}
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onSubmit={(answers) => task.respondQuestions(answers)}
          onCancel={() => task.cancelQuestions()}
        />
      ) : null}
      {snapshot.archivedAt ? (
        <View
          style={[
            styles.archivedCalloutWrap,
            { paddingBottom: Math.max(bottomInset, spacing.md) },
          ]}
        >
          <View style={styles.archivedCallout}>
            <ArchiveRestore size={19} color={colors.textMuted} />
            <Text style={styles.archivedCalloutText}>
              此任务已归档，恢复后才能继续对话。
            </Text>
            <Pressable
              testID="unarchive-task"
              disabled={!snapshot.connected || unarchiving}
              accessibilityState={{
                disabled: !snapshot.connected || unarchiving,
                busy: unarchiving,
              }}
              onPress={() =>
                void (async () => {
                  if (unarchiving) return;
                  setUnarchiving(true);
                  setUnarchiveError(null);
                  try {
                    await task.unarchive();
                  } catch (value) {
                    setUnarchiveError(
                      value instanceof Error ? value.message : String(value),
                    );
                  } finally {
                    setUnarchiving(false);
                  }
                })()
              }
              style={[
                styles.archivedCalloutButton,
                (!snapshot.connected || unarchiving) && styles.sendDisabled,
              ]}
            >
              {unarchiving ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <Text style={styles.archivedCalloutButtonText}>恢复</Text>
              )}
            </Pressable>
          </View>
          {unarchiveError ? (
            <Text accessibilityRole="alert" style={styles.attachmentError}>
              {unarchiveError}
            </Text>
          ) : null}
        </View>
      ) : (
        <View
          style={[
            styles.composerWrap,
            { paddingBottom: Math.max(bottomInset, spacing.sm) },
          ]}
        >
          {attachmentError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentError}
            >
              {attachmentError}
            </Text>
          ) : null}
          {queueError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentError}
            >
              {queueError}
            </Text>
          ) : null}
          {composerNotice ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.composerNotice}
            >
              {composerNotice}
            </Text>
          ) : null}
          {queuedMessages.length > 0 ? (
            <ScrollView
              testID="queued-messages"
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.queueList}
            >
              {queuedMessages.map((message, index) => (
                <View
                  key={message.id}
                  testID={`queued-message-${index}`}
                  style={styles.queueChip}
                >
                  <View style={styles.queueIndex}>
                    <Text style={styles.queueIndexText}>{index + 1}</Text>
                  </View>
                  <View style={styles.queueCopy}>
                    <Text numberOfLines={1} style={styles.queueText}>
                      {message.content ||
                        `附件 ${message.attachments.length} 个`}
                    </Text>
                    <Text style={styles.queueMeta}>
                      等待当前回合 ·{" "}
                      {message.attachments.length > 0
                        ? `${message.attachments.length} 个附件`
                        : "消息"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`移除排队消息 ${index + 1}`}
                    onPress={() => removeQueuedMessage(message.id)}
                    style={styles.queueRemove}
                  >
                    <X size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.attachmentList}
            >
              {attachments.map((attachment) => (
                <StagedAttachmentChip
                  key={attachment.path}
                  attachment={attachment}
                  task={task}
                  onRemove={() => void removeAttachment(attachment)}
                />
              ))}
            </ScrollView>
          ) : null}
          {slashCommands.length > 0 ? (
            <ScrollView
              testID="slash-command-menu"
              accessibilityRole="menu"
              nestedScrollEnabled
              showsVerticalScrollIndicator
              contentContainerStyle={styles.slashMenuContent}
              style={styles.slashMenu}
            >
              {slashCommands.map((command) => (
                <Pressable
                  key={command.name}
                  testID={`slash-command-${command.name.slice(1)}`}
                  accessibilityRole="menuitem"
                  onPress={() => selectSlashCommand(command)}
                  style={({ pressed }) => [
                    styles.slashMenuRow,
                    pressed && styles.slashMenuRowPressed,
                  ]}
                >
                  <Text style={styles.slashMenuName}>{command.name}</Text>
                  <Text numberOfLines={1} style={styles.slashMenuDescription}>
                    {command.description}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <View testID="message-input-root" style={styles.composer}>
            <Pressable
              testID="composer-attachment"
              accessibilityLabel="添加附件"
              disabled={!snapshot.connected}
              accessibilityState={{ disabled: !snapshot.connected }}
              onPress={openAttachmentSheet}
              style={[
                styles.attachButton,
                !snapshot.connected && styles.sendDisabled,
              ]}
            >
              <Paperclip size={19} color={colors.textMuted} />
            </Pressable>
            <TextInput
              ref={messageInputRef}
              testID="message-input"
              value={input}
              onChangeText={(value) => {
                setInput(value);
                setQueueError(null);
                setComposerNotice(null);
              }}
              maxLength={MAX_TASK_MESSAGE_CHARACTERS}
              multiline
              placeholder={
                snapshot.running ? "输入后加入发送队列…" : "发送消息…"
              }
              placeholderTextColor={colors.textDim}
              style={styles.composerInput}
              editable={snapshot.connected}
            />
            {snapshot.running ? (
              <Pressable
                testID="stop-turn"
                accessibilityRole="button"
                accessibilityLabel="停止"
                onPress={() => void task.interrupt()}
                style={styles.stopButton}
              >
                <Square size={14} fill={colors.text} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              testID={snapshot.running ? "queue-message" : "send-message"}
              accessibilityRole="button"
              accessibilityLabel={snapshot.running ? "排队发送" : "发送"}
              disabled={!canSend}
              accessibilityState={{ disabled: !canSend }}
              onPress={() => void submit()}
              style={[styles.sendButton, !canSend && styles.sendDisabled]}
            >
              <ArrowUp size={19} color={colors.accentText} />
            </Pressable>
          </View>
          <View style={styles.composerMeta}>
            <Pressable
              testID="conversation-model-selector"
              accessibilityLabel="切换模型和推理强度"
              disabled={
                !snapshot.connected ||
                snapshot.running ||
                Boolean(snapshot.archivedAt)
              }
              accessibilityState={{
                disabled:
                  !snapshot.connected ||
                  snapshot.running ||
                  Boolean(snapshot.archivedAt),
              }}
              onPress={openModelPicker}
              style={styles.modelSelectorMeta}
            >
              <Text numberOfLines={1} style={styles.model}>
                {selectedModelOption?.displayName ?? snapshot.model?.split("::").at(-1) ?? "服务器默认模型"}
                {snapshot.reasoningEffort
                  ? ` · ${reasoningEffortLabel(snapshot.reasoningEffort)}`
                  : ""}
              </Text>
              <ChevronDown size={12} color={colors.textDim} />
            </Pressable>
            <Text style={styles.connection}>
              {queuedMessages.length > 0
                ? `排队 ${queuedMessages.length}`
                : snapshot.connected
                  ? "已连接"
                  : "离线"}
            </Text>
          </View>
        </View>
      )}
      <Modal
        visible={attachmentSheet}
        transparent
        animationType="slide"
        accessibilityLabel="添加附件"
        onRequestClose={closeAttachmentSheet}
      >
        <Pressable style={styles.sheetOverlay} onPress={closeAttachmentSheet} />
        <View
          ref={attachmentSheetRef}
          style={[
            styles.attachmentSheet,
            { paddingBottom: Math.max(bottomInset, spacing.lg) },
          ]}
        >
          <View style={styles.attachmentSheetHeader}>
            <Text style={styles.attachmentSheetTitle}>添加附件</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              disabled={attachmentLoading}
              accessibilityState={{
                disabled: attachmentLoading,
                busy: attachmentLoading,
              }}
              onPress={closeAttachmentSheet}
              style={[
                styles.modalClose,
                attachmentLoading && styles.sendDisabled,
              ]}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void takePhoto()}
            style={styles.attachmentAction}
          >
            <Camera size={21} color={colors.green} />
            <View>
              <Text style={styles.attachmentActionTitle}>拍照</Text>
              <Text style={styles.attachmentActionBody}>
                使用相机拍摄并附加当前画面
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void pickImage()}
            style={styles.attachmentAction}
          >
            <ImageIcon size={21} color={colors.green} />
            <View>
              <Text style={styles.attachmentActionTitle}>照片图库</Text>
              <Text style={styles.attachmentActionBody}>
                选择图片并发送给支持视觉的模型
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void pickFile()}
            style={styles.attachmentAction}
          >
            <FileUp size={21} color={colors.blue} />
            <View>
              <Text style={styles.attachmentActionTitle}>选择文件</Text>
              <Text style={styles.attachmentActionBody}>
                从设备文件系统添加附件
              </Text>
            </View>
          </Pressable>
          {attachmentLoading ? (
            <View
              accessibilityRole="progressbar"
              style={styles.attachmentProgress}
            >
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={styles.attachmentActionBody}>
                正在处理附件，请稍候…
              </Text>
            </View>
          ) : null}
          {attachmentError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentSheetError}
            >
              {attachmentError}
            </Text>
          ) : null}
        </View>
      </Modal>
      <Modal
        visible={modelPickerOpen}
        transparent
        animationType="slide"
        accessibilityLabel="切换模型"
        onRequestClose={closeModelPicker}
      >
        <Pressable style={styles.sheetOverlay} onPress={closeModelPicker} />
        <View
          ref={modelPickerRef}
          role="dialog"
          accessibilityViewIsModal
          style={[
            styles.modelPickerSheet,
            { paddingBottom: Math.max(bottomInset, spacing.lg) },
          ]}
        >
          <View style={styles.attachmentSheetHeader}>
            <View>
              <Text style={styles.attachmentSheetTitle}>模型与推理强度</Text>
              <Text style={styles.modelPickerSubtitle}>
                只影响此任务之后发送的回合
              </Text>
            </View>
            <Pressable
              accessibilityLabel="关闭"
              disabled={modelBusy}
              onPress={closeModelPicker}
              style={styles.modalClose}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          {modelsLoading ? (
            <View style={styles.modelPickerLoading}>
              <ActivityIndicator color={colors.textMuted} />
              <Text style={styles.modelPickerSubtitle}>
                正在读取服务器模型…
              </Text>
            </View>
          ) : null}
          {modelError ? (
            <Text accessibilityRole="alert" style={styles.attachmentError}>
              {modelError}
            </Text>
          ) : null}
          <ScrollView
            style={styles.modelPickerList}
            contentContainerStyle={styles.modelPickerContent}
          >
            {modelOptions.map((item) => {
              const checked = selectedModelOption?.id === item.id;
              return (
                <Pressable
                  key={item.id}
                  testID={`conversation-model-${item.id}`}
                  accessibilityRole="radio"
                  aria-checked={checked}
                  accessibilityState={{ checked, disabled: modelBusy }}
                  disabled={modelBusy}
                  onPress={() =>
                    void applyTurnPreferences(
                      modelOptionSelector(item),
                      item.supportedReasoningEfforts?.includes(
                        snapshot.reasoningEffort ?? "",
                      )
                        ? snapshot.reasoningEffort
                        : item.defaultReasoningEffort,
                    )
                  }
                  style={[
                    styles.modelPickerOption,
                    checked && styles.modelPickerSelected,
                  ]}
                >
                  <View style={styles.modelPickerCopy}>
                    <Text style={styles.modelPickerName}>
                      {item.displayName}
                    </Text>
                    <Text style={styles.modelPickerProvider}>
                      {item.providerName}
                      {item.supportsVision ? " · 支持图片" : ""}
                    </Text>
                  </View>
                  {checked ? (
                    <Text style={styles.modelPickerCheck}>✓</Text>
                  ) : null}
                </Pressable>
              );
            })}
            {!modelsLoading && modelOptions.length === 0 ? (
              <Text style={styles.modelPickerEmpty}>
                服务器没有返回可切换的模型。
              </Text>
            ) : null}
          </ScrollView>
          {(selectedModelOption?.supportedReasoningEfforts?.length ?? 0) > 0 ? (
            <View>
              <Text style={styles.modelPickerSection}>推理强度</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.modelEffortList}
              >
                {selectedModelOption?.supportedReasoningEfforts?.map(
                  (effort) => {
                    const checked = snapshot.reasoningEffort === effort;
                    return (
                      <Pressable
                        key={effort}
                        accessibilityRole="radio"
                        aria-checked={checked}
                        accessibilityState={{ checked, disabled: modelBusy }}
                        disabled={modelBusy}
                        onPress={() =>
                          void applyTurnPreferences(
                            modelOptionSelector(selectedModelOption),
                            effort,
                          )
                        }
                        style={[
                          styles.modelEffort,
                          checked && styles.modelEffortSelected,
                        ]}
                      >
                        <Text
                          style={[
                            styles.modelEffortText,
                            checked && styles.modelEffortTextSelected,
                          ]}
                        >
                          {reasoningEffortLabel(effort)}
                        </Text>
                      </Pressable>
                    );
                  },
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  task,
  onOpenFile,
  onOpenChanges,
}: {
  message: ChatMessage;
  task: TaskRuntime;
  onOpenFile(link: string): boolean;
  onOpenChanges(): void;
}) {
  const user = message.role === "user";
  const workspaceRoot = task.getSnapshot().cwd;
  const openLink = (url: string) => {
    if (onOpenFile(url)) return;
    if (/^(?:https?:|mailto:)/i.test(url))
      void Linking.openURL(url).catch(() => {});
  };
  const rules: RenderRules = {
    link: (node, children, _parents, markdownRuleStyles) => (
      <Text
        key={node.key}
        accessibilityRole="link"
        accessibilityHint="打开链接"
        onPress={() => openLink(String(node.attributes.href ?? ""))}
        style={markdownRuleStyles.link}
      >
        {children}
      </Text>
    ),
    code_inline: (
      node,
      _children,
      _parents,
      markdownRuleStyles,
      inheritedStyles,
    ) => {
      const isWorkspaceFile = Boolean(
        workspaceFilePathFromInlineCode(node.content, workspaceRoot),
      );
      return (
        <Text
          key={node.key}
          accessibilityRole={isWorkspaceFile ? "link" : undefined}
          accessibilityHint={isWorkspaceFile ? "在文件面板中打开" : undefined}
          onPress={isWorkspaceFile ? () => onOpenFile(node.content) : undefined}
          style={[
            inheritedStyles,
            markdownRuleStyles.code_inline,
            isWorkspaceFile && markdownStyles.fileCodeLink,
          ]}
        >
          {node.content}
        </Text>
      );
    },
  };
  return (
    <View
      testID={user ? "message-user" : "message-assistant"}
      style={[styles.messageRow, user && styles.userMessageRow]}
    >
      <View
        style={[
          styles.messageBubble,
          user ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        {!user ? (
          <View style={styles.assistantLabel}>
            <Bot size={16} color={colors.textMuted} />
            <Text style={styles.assistantLabelText}>KCoder</Text>
          </View>
        ) : null}
        {message.thinking ? (
          <ThinkingDisclosure content={message.thinking} />
        ) : null}
        {message.content ? (
          user ? (
            <Text selectable style={styles.userText}>
              {message.content}
            </Text>
          ) : (
            <Markdown rules={rules} style={markdownStyles}>
              {message.content}
            </Markdown>
          )
        ) : null}
        {!user && message.status === "cancelled" ? (
          <Text accessibilityRole="text" style={styles.cancelledMessage}>
            已停止
          </Text>
        ) : null}
        {message.attachments?.map((attachment) => (
          <MessageAttachment
            key={attachment.path}
            attachment={attachment}
            task={task}
          />
        ))}
        {message.todos ? <TodoCard todos={message.todos} /> : null}
        {message.activities?.map((activity) => (
          <ActivityCard
            key={activity.id}
            activity={activity}
            onSteer={
              activity.agentId
                ? async (value) =>
                    (await task.steerSubagent(activity.agentId!, value)).queued
                : undefined
            }
          />
        ))}
        {message.interactionSummaries?.map((summary) => (
          <InteractionSummaryCard key={summary.id} summary={summary} />
        ))}
        {message.tools?.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}
        {message.fileChanges ? (
          <FileChangesCard
            changes={message.fileChanges}
            onOpenChanges={onOpenChanges}
          />
        ) : null}
      </View>
    </View>
  );
});

function InteractionSummaryCard({
  summary,
}: {
  summary: NonNullable<ChatMessage["interactionSummaries"]>[number];
}) {
  return (
    <View
      testID={`interaction-summary-${summary.id}`}
      style={styles.timelineCard}
    >
      <View style={styles.timelineHeader}>
        <ShieldCheck size={15} color={colors.green} />
        <View style={styles.toolCopy}>
          <Text style={styles.timelineTitle}>{summary.header}</Text>
          {summary.prompt ? (
            <Text selectable style={styles.timelineDetail}>
              {summary.prompt}
            </Text>
          ) : null}
          <Text selectable style={styles.interactionAnswer}>
            {summary.answers.join("、")}
          </Text>
        </View>
      </View>
    </View>
  );
}

function TodoCard({ todos }: { todos: NonNullable<ChatMessage["todos"]> }) {
  const [expanded, setExpanded] = useState(false);
  const completed = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const next =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending");
  return (
    <View testID="todo-card" style={styles.timelineCard}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={expanded}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.timelineHeader}
      >
        <ListTodo size={15} color={colors.blue} />
        <View style={styles.toolCopy}>
          <Text style={styles.timelineTitle}>
            任务清单 · {completed}/{todos.length}
          </Text>
          {!expanded && next ? (
            <Text numberOfLines={1} style={styles.timelineDetail}>
              {next.content}
            </Text>
          ) : null}
        </View>
        {expanded ? (
          <ChevronDown size={15} color={colors.textDim} />
        ) : (
          <ChevronRight size={15} color={colors.textDim} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.todoList}>
          {todos.map((todo, index) => {
            const done =
              todo.status === "completed" || todo.status === "cancelled";
            return (
              <View key={`${todo.content}-${index}`} style={styles.todoRow}>
                <View style={[styles.todoDot, done && styles.todoDotDone]}>
                  {done ? <Check size={11} color={colors.background} /> : null}
                </View>
                <Text style={[styles.todoText, done && styles.todoTextDone]}>
                  {todo.content}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ActivityCard({
  activity,
  onSteer,
}: {
  activity: NonNullable<ChatMessage["activities"]>[number];
  onSteer?: (message: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone =
    activity.status === "failed"
      ? colors.red
      : activity.status === "running"
        ? colors.yellow
        : activity.status === "cancelled"
          ? colors.textDim
          : colors.green;
  const steerLabel =
    activity.steerStatus === "applied"
      ? "调整已应用"
      : activity.steerStatus?.startsWith("queued")
        ? "调整已排队"
        : activity.steerStatus === "resuming"
          ? "正在恢复"
          : null;
  return (
    <View
      testID={`activity-${encodeURIComponent(activity.id)}`}
      accessibilityRole={activity.status === "failed" ? "alert" : undefined}
      style={styles.activityCard}
    >
      <View style={styles.activityHeader}>
        <View style={[styles.activityDot, { backgroundColor: tone }]} />
        <View style={styles.toolCopy}>
          <Text style={styles.activityLabel}>{activity.label}</Text>
          {activity.detail ? (
            <Text selectable style={styles.timelineDetail}>
              {activity.detail}
            </Text>
          ) : null}
          {steerLabel ? (
            <Text testID="subagent-steer-status" style={styles.timelineDetail}>
              {steerLabel}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.activityStatus, { color: tone }]}>
          {activity.status === "running"
            ? "进行中"
            : activity.status === "failed"
              ? "失败"
              : activity.status === "cancelled"
                ? "已取消"
                : "完成"}
        </Text>
        {onSteer && activity.status === "running" ? (
          <Pressable
            testID="subagent-steer-open"
            accessibilityRole="button"
            accessibilityLabel={`调整 ${activity.label}`}
            onPress={() => {
              setEditing((value) => !value);
              setError(null);
            }}
            style={styles.activitySteerButton}
          >
            <Text style={styles.activitySteerButtonText}>调整</Text>
          </Pressable>
        ) : null}
      </View>
      {editing && onSteer ? (
        <View style={styles.activitySteerForm}>
          <TextInput
            testID="subagent-steer-input"
            accessibilityLabel="新的子智能体指令"
            multiline
            value={draft}
            editable={!pending}
            onChangeText={setDraft}
            style={styles.activitySteerInput}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.activitySteerError}>
              {error}
            </Text>
          ) : null}
          <View style={styles.activitySteerActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditing(false)}
              style={styles.activitySteerCancel}
            >
              <Text style={styles.activitySteerCancelText}>取消</Text>
            </Pressable>
            <Pressable
              testID="subagent-steer-submit"
              accessibilityRole="button"
              disabled={!draft.trim() || pending}
              onPress={() => {
                const message = draft.trim();
                if (!message || pending) return;
                setPending(true);
                setError(null);
                void onSteer(message)
                  .then((accepted) => {
                    if (accepted) {
                      setEditing(false);
                      setDraft("");
                    } else setError("指令未能进入队列");
                  })
                  .catch((value) =>
                    setError(
                      value instanceof Error ? value.message : String(value),
                    ),
                  )
                  .finally(() => setPending(false));
              }}
              style={[
                styles.activitySteerSubmit,
                (!draft.trim() || pending) && styles.disabledButton,
              ]}
            >
              <ArrowUp size={16} color={colors.background} />
              <Text style={styles.activitySteerSubmitText}>
                {pending ? "发送中…" : "发送"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function useAttachmentAccess(
  attachment: StagedAttachment,
  task: TaskRuntime,
  localPreviewUri?: string,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const contentRef = useRef<string | null>(null);
  const previewMime =
    attachment.fileSize <= DIRECT_ATTACHMENT_BYTES
      ? previewableRasterMimeType(attachment.mimeType)
      : null;
  const closePreview = () => {
    setPreviewUri(null);
    setPreviewFailed(false);
    setError(null);
  };
  const read = async () => {
    if (contentRef.current) return contentRef.current;
    const result = await task.request<{
      contentBase64?: string;
      size?: number;
    }>("attachment/read", {
      threadId: task.getSnapshot().threadId,
      path: attachment.path,
    });
    if (!result.contentBase64) throw new Error("app-server 未返回附件内容");
    if (result.size !== undefined && result.size > 256 * 1024)
      throw new Error("附件超过 256 KiB 预览限制");
    contentRef.current = result.contentBase64;
    return result.contentBase64;
  };
  const readChunks = async (consume: (bytes: Uint8Array) => void) => {
    let offset = 0;
    let expectedTotal: number | null = null;
    for (;;) {
      const result = await task.request<{
        contentBase64?: string;
        offset?: number;
        size?: number;
        totalSize?: number;
        eof?: boolean;
      }>("attachment/read/chunk", {
        threadId: task.getSnapshot().threadId,
        path: attachment.path,
        offset,
        length: 512 * 1024,
      });
      if (result.offset !== offset || typeof result.contentBase64 !== "string")
        throw new Error("app-server 返回了无效的附件分片");
      const bytes = toByteArray(result.contentBase64);
      if (
        result.size !== bytes.length ||
        !Number.isSafeInteger(result.totalSize) ||
        result.totalSize! < 0 ||
        result.totalSize! > MAX_ATTACHMENT_BYTES
      ) {
        throw new Error("app-server 返回了无效的附件大小");
      }
      if (expectedTotal !== null && result.totalSize !== expectedTotal)
        throw new Error("附件下载期间大小发生变化");
      expectedTotal = result.totalSize!;
      if (bytes.length === 0 && !result.eof)
        throw new Error("app-server 返回了空的非末尾附件分片");
      consume(bytes);
      offset += bytes.length;
      if (result.eof) {
        if (offset !== expectedTotal) throw new Error("附件下载未完整结束");
        return;
      }
      if (offset >= expectedTotal)
        throw new Error("app-server 返回了无效的附件末尾状态");
    }
  };
  const saveOrShare = async (contentBase64?: string) => {
    if (
      contentBase64 !== undefined ||
      attachment.fileSize <= DIRECT_ATTACHMENT_BYTES
    ) {
      const encoded = contentBase64 ?? (await read());
      const uri = `data:${attachment.mimeType};base64,${encoded}`;
      if (Platform.OS === "web" && globalThis.document) {
        const anchor = globalThis.document.createElement("a");
        anchor.href = uri;
        anchor.download = attachment.filename;
        anchor.rel = "noopener";
        globalThis.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }
      if (!cacheDirectory) throw new Error("设备没有可用的附件缓存目录");
      const safeName =
        attachment.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
      const path = `${cacheDirectory}kcoder-${Date.now()}-${safeName}`;
      await writeAsStringAsync(path, encoded, {
        encoding: EncodingType.Base64,
      });
      if (await Sharing.isAvailableAsync()) {
        try {
          await Sharing.shareAsync(path, {
            mimeType: attachment.mimeType,
            dialogTitle: `分享 ${attachment.filename}`,
          });
        } finally {
          await deleteAsync(path, { idempotent: true });
        }
      } else await Linking.openURL(path);
      return;
    }
    if (Platform.OS === "web" && globalThis.document) {
      const chunks: ArrayBuffer[] = [];
      await readChunks((bytes) => chunks.push(Uint8Array.from(bytes).buffer));
      const url = globalThis.URL.createObjectURL(
        new Blob(chunks, { type: attachment.mimeType }),
      );
      const anchor = globalThis.document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.rel = "noopener";
      globalThis.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1_000);
      return;
    }
    if (!cacheDirectory) throw new Error("设备没有可用的附件缓存目录");
    const safeName =
      attachment.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
    const path = `${cacheDirectory}kcoder-${Date.now()}-${safeName}`;
    const file = new ExpoFile(path);
    file.create({ overwrite: true, intermediates: true });
    const handle = file.open();
    try {
      await readChunks((bytes) => handle.writeBytes(bytes));
    } catch (value) {
      handle.close();
      file.delete();
      throw value;
    }
    handle.close();
    if (await Sharing.isAvailableAsync()) {
      try {
        await Sharing.shareAsync(file.uri, {
          mimeType: attachment.mimeType,
          dialogTitle: `分享 ${attachment.filename}`,
        });
      } finally {
        file.delete();
      }
    } else await Linking.openURL(file.uri);
  };
  const open = async () => {
    if (loading) return;
    if (previewMime && localPreviewUri) {
      setError(null);
      setPreviewFailed(false);
      setPreviewUri(localPreviewUri);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (previewMime) {
        const encoded = await read();
        setPreviewFailed(false);
        setPreviewUri(`data:${previewMime};base64,${encoded}`);
      } else await saveOrShare();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };
  const download = async () => {
    setLoading(true);
    setError(null);
    try {
      await saveOrShare();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };
  return {
    loading,
    error,
    previewUri,
    previewFailed,
    previewMime,
    closePreview,
    open,
    download,
    setError,
    setPreviewFailed,
  };
}

type AttachmentAccess = ReturnType<typeof useAttachmentAccess>;

function AttachmentLightbox({
  attachment,
  access,
}: {
  attachment: StagedAttachment;
  access: AttachmentAccess;
}) {
  const insets = useSafeAreaInsets();
  const previewRef = useModalFocusTrap(
    Boolean(access.previewUri),
    access.closePreview,
  );
  return (
    <Modal
      visible={Boolean(access.previewUri)}
      transparent
      animationType="fade"
      statusBarTranslucent
      accessibilityLabel={`预览 ${attachment.filename}`}
      onRequestClose={access.closePreview}
    >
      <View
        ref={previewRef}
        role="dialog"
        accessibilityViewIsModal
        style={styles.attachmentLightbox}
      >
        <Pressable
          testID="attachment-lightbox-backdrop"
          accessibilityLabel="关闭附件预览"
          onPress={access.closePreview}
          style={StyleSheet.absoluteFillObject}
        />
        {access.previewUri && !access.previewFailed ? (
          <Image
            testID="attachment-lightbox-image"
            source={{ uri: access.previewUri }}
            onError={() => {
              access.setPreviewFailed(true);
              access.setError("图片无法解码或格式不受当前设备支持");
            }}
            resizeMode="contain"
            style={styles.attachmentLightboxImage}
          />
        ) : null}
        {access.previewFailed ? (
          <Text accessibilityRole="alert" style={styles.lightboxError}>
            图片无法解码或格式不受当前设备支持
          </Text>
        ) : null}
        {access.error && !access.previewFailed ? (
          <Text accessibilityRole="alert" style={styles.lightboxError}>
            {access.error}
          </Text>
        ) : null}
        <View
          style={[
            styles.attachmentLightboxActions,
            { top: insets.top + spacing.md, right: insets.right + spacing.md },
          ]}
        >
          <Pressable
            accessibilityLabel="下载或分享附件"
            disabled={access.loading}
            accessibilityState={{
              disabled: access.loading,
              busy: access.loading,
            }}
            onPress={() => void access.download()}
            style={[
              styles.lightboxButton,
              access.loading && styles.sendDisabled,
            ]}
          >
            {access.loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Download size={20} color="#fff" />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel="关闭附件预览"
            onPress={access.closePreview}
            style={styles.lightboxButton}
          >
            <X size={20} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function StagedAttachmentChip({
  attachment,
  task,
  onRemove,
}: {
  attachment: ComposerStagedAttachment;
  task: TaskRuntime;
  onRemove(): void;
}) {
  const access = useAttachmentAccess(
    attachment,
    task,
    attachment.localPreviewUri,
  );
  return (
    <>
      <View style={styles.stagedAttachmentItem}>
        <View style={styles.attachmentChip}>
          <Pressable
            testID={`staged-attachment-${encodeURIComponent(attachment.filename)}`}
            accessibilityRole="button"
            accessibilityLabel={`${access.previewMime ? "预览" : "下载"}待发送附件 ${attachment.filename}`}
            disabled={access.loading}
            accessibilityState={{
              disabled: access.loading,
              busy: access.loading,
            }}
            onPress={() => void access.open()}
            style={styles.attachmentChipOpen}
          >
            <Paperclip size={13} color={colors.textMuted} />
            <Text numberOfLines={1} style={styles.attachmentName}>
              {attachment.filename}
            </Text>
            {access.loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`移除 ${attachment.filename}`}
            onPress={onRemove}
            hitSlop={8}
            style={styles.attachmentChipRemove}
          >
            <X size={15} color={colors.textMuted} />
          </Pressable>
        </View>
        {access.error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.stagedAttachmentError}
          >
            {access.error}
          </Text>
        ) : null}
      </View>
      <AttachmentLightbox attachment={attachment} access={access} />
    </>
  );
}

function MessageAttachment({
  attachment,
  task,
}: {
  attachment: StagedAttachment;
  task: TaskRuntime;
}) {
  const access = useAttachmentAccess(attachment, task);
  return (
    <>
      <Pressable
        testID={`message-attachment-${encodeURIComponent(attachment.filename)}`}
        accessibilityRole="button"
        accessibilityLabel={`${access.previewMime ? "预览" : "下载"}附件 ${attachment.filename}`}
        disabled={access.loading}
        accessibilityState={{ disabled: access.loading, busy: access.loading }}
        onPress={() => void access.open()}
        style={styles.messageAttachment}
      >
        <Paperclip size={14} color={colors.textMuted} />
        <View style={styles.messageAttachmentCopy}>
          <Text numberOfLines={1} style={styles.messageAttachmentText}>
            {attachment.filename}
          </Text>
          <Text style={styles.messageAttachmentMeta}>
            {attachment.mimeType}
            {attachment.fileSize
              ? ` · ${Math.max(1, Math.ceil(attachment.fileSize / 1024))} KiB`
              : ""}
          </Text>
        </View>
        {access.loading ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Download size={16} color={colors.textMuted} />
        )}
      </Pressable>
      {access.error ? (
        <Text accessibilityRole="alert" style={styles.attachmentError}>
          {access.error}
        </Text>
      ) : null}
      <AttachmentLightbox attachment={attachment} access={access} />
    </>
  );
}

function ThinkingDisclosure({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View testID="thinking-disclosure" style={styles.thinkingBox}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={expanded}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.disclosureHeader}
      >
        {expanded ? (
          <ChevronDown size={15} color={colors.textMuted} />
        ) : (
          <ChevronRight size={15} color={colors.textMuted} />
        )}
        <Text style={styles.thinkingTitle}>思考过程</Text>
      </Pressable>
      {expanded ? (
        <Text selectable style={styles.thinkingText}>
          {content}
        </Text>
      ) : (
        <Text numberOfLines={2} style={styles.thinkingPreview}>
          {content}
        </Text>
      )}
    </View>
  );
}

function displayToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function RuntimeErrorBanner({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [error]);
  const summary = runtimeErrorSummary(error);
  const hasDetails = summary !== error;
  return (
    <View
      testID="runtime-error-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={styles.errorBanner}
    >
      <Text style={styles.errorText}>{expanded ? error : summary}</Text>
      {hasDetails ? (
        <Pressable
          testID="runtime-error-details"
          accessibilityRole="button"
          aria-expanded={expanded}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.errorDetailsButton}
        >
          <Text style={styles.errorDetailsText}>
            {expanded ? "收起技术详情" : "查看技术详情"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ToolCallCard({
  tool,
}: {
  tool: NonNullable<ChatMessage["tools"]>[number];
}) {
  const [expanded, setExpanded] = useState(tool.status === "failed");
  const hasDetails = tool.input !== undefined || tool.output !== undefined;
  return (
    <View
      testID={`tool-call-${encodeURIComponent(tool.id)}`}
      style={styles.tool}
    >
      <Pressable
        disabled={!hasDetails}
        accessibilityRole="button"
        aria-expanded={hasDetails ? expanded : undefined}
        accessibilityState={{
          expanded: hasDetails ? expanded : undefined,
          disabled: !hasDetails,
        }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.toolHeader}
      >
        <Wrench
          size={15}
          color={
            tool.status === "failed"
              ? colors.red
              : tool.status === "running"
                ? colors.yellow
                : colors.textMuted
          }
        />
        <View style={styles.toolCopy}>
          <Text style={styles.toolName}>{tool.name}</Text>
          {!expanded && tool.output !== undefined ? (
            <Text numberOfLines={2} style={styles.toolOutput}>
              {displayToolValue(tool.output)}
            </Text>
          ) : null}
        </View>
        <Text
          style={[
            styles.toolStatus,
            tool.status === "running" && styles.toolRunning,
            tool.status === "failed" && styles.toolFailed,
          ]}
        >
          {tool.status === "running"
            ? "运行中"
            : tool.status === "failed"
              ? "失败"
              : "完成"}
        </Text>
        {hasDetails ? (
          expanded ? (
            <ChevronDown size={15} color={colors.textDim} />
          ) : (
            <ChevronRight size={15} color={colors.textDim} />
          )
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetails}>
          {tool.input !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>输入</Text>
              <ScrollView horizontal>
                <Text selectable style={styles.toolDetailCode}>
                  {displayToolValue(tool.input)}
                </Text>
              </ScrollView>
            </View>
          ) : null}
          {tool.output !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>输出</Text>
              <ScrollView horizontal>
                <Text selectable style={styles.toolDetailCode}>
                  {displayToolValue(tool.output)}
                </Text>
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function FileChangesCard({
  changes,
  onOpenChanges,
}: {
  changes: FileChangesView;
  onOpenChanges(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`审查 ${changes.fileCount} 个文件变更`}
      onPress={onOpenChanges}
      style={({ pressed }) => [
        styles.changesCard,
        pressed && styles.changeCardPressed,
      ]}
    >
      <View style={styles.changesHeader}>
        <View style={styles.changesHeading}>
          <GitCompareArrows size={15} color={colors.textMuted} />
          <Text style={styles.changesTitle}>
            文件变更 · {changes.fileCount}
          </Text>
        </View>
        <View style={styles.changeSummary}>
          <Text style={styles.changeAdditions}>+{changes.additions}</Text>
          <Text style={styles.changeDeletions}>-{changes.deletions}</Text>
          <ChevronRight size={16} color={colors.textDim} />
        </View>
      </View>
      {changes.files.slice(0, 3).map((file) => (
        <Text key={file} numberOfLines={1} style={styles.changedFile}>
          {file}
        </Text>
      ))}
      {changes.files.length > 3 ? (
        <Text style={styles.changedFile}>
          另有 {changes.files.length - 3} 个文件
        </Text>
      ) : null}
      <Text style={styles.reviewHint}>
        {changes.status === "reverted"
          ? "变更已撤销"
          : "在 Changes 工作区中审查逐行 diff"}
      </Text>
    </Pressable>
  );
}

function PanelMenu({
  visible,
  canAdd,
  onClose,
  onAdd,
}: {
  visible: boolean;
  canAdd: boolean;
  onClose(): void;
  onAdd(kind: Exclude<WorkspaceTab, "agent">): void;
}) {
  const modalRef = useModalFocusTrap(visible, onClose);
  const option = (
    kind: Exclude<WorkspaceTab, "agent">,
    icon: React.ReactNode,
    title: string,
    body: string,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !canAdd }}
      disabled={!canAdd}
      onPress={() => onAdd(kind)}
      style={[styles.panelMenuRow, !canAdd && styles.sendDisabled]}
    >
      {icon}
      <View>
        <Text style={styles.panelMenuTitle}>{title}</Text>
        <Text style={styles.panelMenuBody}>{body}</Text>
      </View>
    </Pressable>
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      accessibilityLabel="新建工作区标签"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.panelMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>新建标签</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            style={styles.modalClose}
          >
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        {!canAdd ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.panelLimitText}
          >
            已达到 12 个工作区标签上限，请先关闭一个标签。
          </Text>
        ) : null}
        {option(
          "terminal",
          <TerminalSquare size={20} color={colors.text} />,
          "终端",
          "启动一个独立 PTY 会话",
        )}
        {option(
          "browser",
          <Globe2 size={20} color={colors.text} />,
          "浏览器",
          "启动一个独立远程浏览器",
        )}
        {option(
          "files",
          <FileCode2 size={20} color={colors.text} />,
          "文件",
          "打开另一个文件浏览与编辑标签",
        )}
      </View>
    </Modal>
  );
}

const markdownStyles = {
  body: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 23,
    ...(Platform.OS === "web"
      ? { overflowWrap: "anywhere" as const, wordBreak: "break-word" as const }
      : {}),
  },
  paragraph: { marginTop: 0, marginBottom: 10 },
  code_inline: {
    color: colors.text,
    backgroundColor: colors.surfaceHover,
    fontFamily: "monospace",
    fontSize: 13,
  },
  fence: {
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    padding: 12,
  },
  code_block: {
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    padding: 12,
  },
  bullet_list: { marginBottom: 10 },
  strong: { fontWeight: "700" as const },
  link: { color: colors.blue },
  fileCodeLink: {
    color: colors.accentBright,
    textDecorationLine: "underline" as const,
  },
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center" },
  loadingWorkspaceLabel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: spacing.md,
  },
  backTextButton: { padding: spacing.lg },
  backText: { color: colors.blue, fontWeight: "600" },
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.xs,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  headerCopy: { flex: 1, alignItems: "center" },
  headerTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    maxWidth: "92%",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 3,
  },
  statusDot: { width: 6, height: 6, borderRadius: 6 },
  online: { backgroundColor: colors.green },
  offline: { backgroundColor: colors.red },
  statusText: { color: colors.textDim, fontSize: 10, maxWidth: 230 },
  retainedPanel: { flex: 1 },
  hiddenPanel: { display: "none" },
  panel: { flex: 1 },
  messageListStage: { flex: 1, position: "relative" },
  messages: { flex: 1 },
  messageContent: {
    paddingVertical: spacing.lg,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  historyButton: {
    minHeight: 44,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  historyButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  jumpToLatest: {
    position: "absolute",
    right: spacing.lg,
    bottom: spacing.lg,
    zIndex: 4,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderAccent,
    backgroundColor: colors.surfaceRaised,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  jumpToLatestText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  messageRow: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    alignItems: "flex-start",
  },
  userMessageRow: { alignItems: "flex-end" },
  messageBubble: { maxWidth: "94%", borderRadius: radius.lg },
  userBubble: {
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomRightRadius: 5,
  },
  assistantBubble: { width: "100%" },
  userText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  assistantLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: spacing.sm,
  },
  assistantLabelText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  cancelledMessage: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  thinkingBox: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.sm,
    marginBottom: spacing.md,
  },
  disclosureHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  thinkingTitle: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  thinkingPreview: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 18,
    paddingLeft: 20,
  },
  thinkingText: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 18,
    paddingLeft: 20,
  },
  tool: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    overflow: "hidden",
  },
  toolHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
  },
  toolCopy: { flex: 1 },
  toolName: { color: colors.text, fontSize: 13, fontWeight: "600" },
  toolOutput: {
    color: colors.textDim,
    fontFamily: "monospace",
    fontSize: 11,
    marginTop: 5,
  },
  toolStatus: { color: colors.green, fontSize: 10, fontWeight: "700" },
  toolRunning: { color: colors.yellow },
  toolFailed: { color: colors.red },
  toolDetails: {
    gap: spacing.md,
    padding: spacing.md,
    paddingTop: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  toolDetailLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 5,
    marginTop: spacing.sm,
  },
  toolDetailCode: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 17,
  },
  timelineCard: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  timelineHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  timelineTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  timelineDetail: {
    color: colors.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  interactionAnswer: {
    color: colors.green,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6,
  },
  todoList: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  todoRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  todoDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.textDim,
    alignItems: "center",
    justifyContent: "center",
  },
  todoDotDone: { borderColor: colors.green, backgroundColor: colors.green },
  todoText: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 18 },
  todoTextDone: { color: colors.textDim, textDecorationLine: "line-through" },
  activityCard: {
    minHeight: 48,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  activityDot: { width: 8, height: 8, borderRadius: 4 },
  activityLabel: { color: colors.text, fontSize: 12, fontWeight: "600" },
  activityStatus: { fontSize: 10, fontWeight: "700" },
  activitySteerButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  activitySteerButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  activitySteerForm: {
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  activitySteerInput: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    color: colors.text,
    backgroundColor: colors.background,
    padding: spacing.md,
    textAlignVertical: "top",
  },
  activitySteerError: { color: colors.red, fontSize: 12 },
  activitySteerActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  activitySteerCancel: {
    minWidth: 72,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  activitySteerCancelText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  activitySteerSubmit: {
    minWidth: 88,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.text,
  },
  activitySteerSubmitText: {
    color: colors.background,
    fontSize: 12,
    fontWeight: "700",
  },
  disabledButton: { opacity: 0.4 },
  changesCard: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: 5,
  },
  changeCardPressed: { backgroundColor: colors.surfaceHover },
  changesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  changesHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  changesTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  changeSummary: { flexDirection: "row", alignItems: "center", gap: 5 },
  changeAdditions: {
    color: colors.green,
    fontFamily: "monospace",
    fontSize: 11,
  },
  changeDeletions: { color: colors.red, fontFamily: "monospace", fontSize: 11 },
  changedFile: {
    color: colors.textMuted,
    fontFamily: "monospace",
    fontSize: 10,
  },
  reviewHint: { color: colors.textDim, fontSize: 10, marginTop: spacing.sm },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  thinkingLabel: { color: colors.textMuted, fontSize: 13 },
  errorBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: "rgba(251,113,133,0.12)",
    borderRadius: radius.md,
  },
  errorText: { color: colors.red, fontSize: 13, lineHeight: 19 },
  errorDetailsButton: {
    minHeight: 44,
    alignSelf: "flex-start",
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  errorDetailsText: {
    color: colors.red,
    fontSize: 12,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  connectionBanner: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: "rgba(250,204,21,0.1)",
  },
  connectionBannerText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  archivedCalloutWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  archivedCallout: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  archivedCalloutText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  archivedCalloutButton: {
    minWidth: 58,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  archivedCalloutButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  composerWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  slashMenu: {
    maxHeight: 228,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  slashMenuContent: { flexGrow: 0 },
  slashMenuRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  slashMenuRowPressed: { backgroundColor: colors.surfaceHover },
  slashMenuName: {
    width: 78,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: "700",
  },
  slashMenuDescription: {
    minWidth: 0,
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
  },
  composer: {
    minHeight: 52,
    maxHeight: 150,
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    backgroundColor: colors.surface,
    paddingLeft: spacing.md,
    paddingRight: 6,
    paddingVertical: 6,
  },
  attachButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -10,
  },
  composerInput: {
    flex: 1,
    minHeight: 38,
    maxHeight: 130,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    paddingTop: 8,
    paddingBottom: 8,
    textAlignVertical: "top",
  },
  stopButton: {
    width: 44,
    height: 44,
    marginRight: 4,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  composerMeta: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
  },
  modelSelectorMeta: {
    minWidth: 44,
    minHeight: 28,
    maxWidth: "78%",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.xs,
  },
  model: { flexShrink: 1, color: colors.textDim, fontSize: 10 },
  connection: { color: colors.textDim, fontSize: 10 },
  queueList: { gap: spacing.sm, paddingBottom: spacing.sm },
  queueChip: {
    width: 250,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  queueIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  queueIndexText: { color: colors.textMuted, fontSize: 10, fontWeight: "700" },
  queueCopy: { flex: 1, minWidth: 0, paddingVertical: 7 },
  queueText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  queueMeta: { marginTop: 3, color: colors.textDim, fontSize: 9 },
  queueRemove: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentList: { gap: spacing.sm, paddingBottom: spacing.sm },
  stagedAttachmentItem: { width: 220, gap: 4 },
  attachmentChip: {
    width: "100%",
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  attachmentChipOpen: {
    minWidth: 0,
    flex: 1,
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: spacing.sm,
  },
  attachmentChipRemove: {
    width: 34,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentName: {
    minWidth: 0,
    flexShrink: 1,
    color: colors.text,
    fontSize: 11,
  },
  stagedAttachmentError: { color: colors.red, fontSize: 10, lineHeight: 14 },
  attachmentError: {
    color: colors.red,
    fontSize: 11,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  composerNotice: {
    color: colors.green,
    fontSize: 11,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  attachmentSheetError: {
    color: colors.red,
    fontSize: 12,
    lineHeight: 18,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: "rgba(198,79,67,0.12)",
  },
  messageAttachment: {
    minHeight: 52,
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  messageAttachmentCopy: { flex: 1, minWidth: 0 },
  messageAttachmentText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  messageAttachmentMeta: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  attachmentLightbox: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  attachmentLightboxImage: {
    width: "100%",
    height: "100%",
    maxWidth: 960,
    maxHeight: 720,
  },
  attachmentLightboxActions: {
    position: "absolute",
    flexDirection: "row",
    gap: spacing.sm,
  },
  lightboxError: {
    maxWidth: 320,
    color: "#fff",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: "rgba(40,40,40,0.9)",
  },
  lightboxButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(30,30,30,0.85)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  modelPickerSheet: {
    maxHeight: "78%",
    marginTop: "auto",
    padding: spacing.lg,
    gap: spacing.md,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.surfaceRaised,
  },
  modelPickerSubtitle: { marginTop: 3, color: colors.textDim, fontSize: 11 },
  modelPickerLoading: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  modelPickerList: { flexGrow: 0, maxHeight: 330 },
  modelPickerContent: { gap: spacing.sm },
  modelPickerOption: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  modelPickerSelected: {
    borderColor: colors.green,
    backgroundColor: "rgba(33,132,84,0.08)",
  },
  modelPickerCopy: { flex: 1 },
  modelPickerName: { color: colors.text, fontSize: 13, fontWeight: "700" },
  modelPickerProvider: { marginTop: 4, color: colors.textDim, fontSize: 10 },
  modelPickerCheck: { color: colors.green, fontSize: 18, fontWeight: "700" },
  modelPickerEmpty: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: "center",
    padding: spacing.lg,
  },
  modelPickerSection: {
    marginBottom: spacing.sm,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },
  modelEffortList: { gap: spacing.sm },
  modelEffort: {
    minWidth: 72,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  modelEffortSelected: {
    borderColor: colors.green,
    backgroundColor: "rgba(33,132,84,0.08)",
  },
  modelEffortText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  modelEffortTextSelected: { color: colors.green },
  sheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  attachmentSheet: {
    marginTop: "auto",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  attachmentSheetHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.sm,
  },
  attachmentSheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  modalClose: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    margin: -10,
  },
  attachmentAction: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  attachmentActionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  attachmentActionBody: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  attachmentProgress: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  taskMenu: {
    marginTop: "auto",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  taskTitleInput: {
    height: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  taskMenuRow: {
    minHeight: 46,
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  taskMenuText: { color: colors.text, fontSize: 14 },
  taskMenuDanger: { color: colors.red, fontSize: 14 },
  taskMenuMessage: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: "center",
  },
  panelMenu: {
    marginTop: "auto",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  panelMenuRow: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  panelMenuTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  panelMenuBody: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  panelLimitText: {
    color: colors.yellow,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: spacing.xs,
  },
});

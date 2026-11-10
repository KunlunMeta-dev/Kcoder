import { useEffect, useRef, useState } from "react";
import { NavigationContext } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ConversationV3Background, ConversationV3Header, ConversationV3WelcomeMark } from "@/features/interface/ConversationV3";
import { ConversationV3Scope } from "@/features/interface/ConversationV3Scope";
import { V3ConversationSelection, V3ConversationSelectionHeader } from "@/features/interface/V3ConversationSelection";
import { ComposerMetaRow, TaskComposer } from "@/features/task/TaskComposer";
import { MessageBubble } from "@/features/task/MessageBubble";
import { JumpToLatestButton } from "@/features/task/TaskTranscript";
import { TaskConnectionNotice } from "@/features/task/TaskConnectionNotice";
import { TaskRuntimeError } from "@/features/task/TaskRuntimeError";
import { initialMessageFollowState } from "@/components/message-follow-state";
import { TaskGoalControls } from "@/features/task/TaskGoalControls";
import { TaskPlanControls } from "@/features/task/TaskPlanControls";
import { TaskMenu } from "@/features/task/TaskMenu";
import { TaskPermissionSheet } from "@/features/task/TaskPermissionSelector";
import { PanelMenu } from "@/features/task/TaskPanels";
import { TaskInteractions } from "@/features/task/TaskInteractions";
import { TranscriptSearchBar } from "@/features/task/TranscriptSearchBar";
import { ApprovalCard, AsyncQuestionCard, QuestionCard } from "@/components/interaction-cards";
import { SessionFiltersPage } from "@/components/session-filters";
import { ConversationPreferencesSettings } from "@/components/settings/ConversationPreferencesSettings";
import { QuickPhrasesSettings } from "@/components/settings/QuickPhrasesSettings";
import { getAppPreferencesSnapshot } from "@/storage/app-preferences";
import { TaskSubagentConversation } from "@/features/task/TaskSubagentConversation";
import { TaskSubagentPanel, TaskSubagentList } from "@/features/task/TaskSubagentView";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import type { AgentSummary, AsyncQuestionRecord } from "@/runtime/task-runtime/types";
import { useTheme } from "@/theme";

const noop = () => {};
const asyncNoop = async () => {};
const NAV = { isFocused: () => true, addListener: () => noop, getState: () => ({ routes: [] }) };
const NOW = Date.parse("2026-10-23T09:00:00Z");
const cwd = "/workspace/user-center";
const owner = { profileId: "fixture", profileAuthorizationScopeKey: "synthetic", serverId: "api", appServerId: "synthetic", threadId: "synthetic-v3", turnId: "turn", appServerEpoch: "epoch" };
const goal = { threadId: owner.threadId, goalId: "synthetic-goal", revision: 1, objective: "完善移动端布局并检查主要操作路径", mode: "continuous", verificationKind: "artifact", status: "active", tokenBudget: 12000, tokensUsed: 2400, timeUsedSeconds: 96, turnCount: 3, createdAt: NOW, updatedAt: NOW };
const todos = [{ content: "检查布局与入口", status: "completed" }, { content: "调整输入区反馈", status: "in_progress" }, { content: "核对窄屏与深色", status: "pending" }];
const REPLY = "## 项目检查结果\n\n当前项目的会话、权限与附件使用同一套控制器。可以先确认目标，再继续修改。\n\n- 保留已有历史。\n- 检查输入区和操作入口。\n\n```ts\nconst message = '继续完善界面';\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 对话布局 | 已检查 |\n| 输入反馈 | 待确认 |";

/** Actual current components with synthetic immutable inputs. All side effects are frozen. */
export default function CurrentV3Fixture() {
  const [name, setName] = useState(() => new URLSearchParams(location.search).get("state") ?? "reply");
  useEffect(() => {
    const restoreScenario = () => setName(new URLSearchParams(location.search).get("state") ?? "reply");
    window.addEventListener("popstate", restoreScenario);
    return () => window.removeEventListener("popstate", restoreScenario);
  }, []);
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const transcriptRef = useRef<ScrollView>(null);
  const followState = useRef(initialMessageFollowState());
  const prependAnchor = useRef(null);
  const [latestDismissedFor, dismissLatest] = useState("");
  const [input, setInput] = useState(name === "long-input" ? "请检查这个项目的会话布局。".repeat(16) : name === "offline" ? "先写下问题，连接后再发送。" : "");
  const [collapsed, collapse] = useState(new Set(name === "selection-collapsed" ? ["api"] : []));
  const [menuOpen, setMenuOpen] = useState(name === "more");
  const [fixtureTitle, setFixtureTitle] = useState("移动端布局检查");
  const [modelPreference, setModelPreference] = useState<{ model: string; reasoningEffort?: string }>({ model: "layout-model", reasoningEffort: "medium" });
  const planOwner = useRef({});
  const [planOpenRequest, setPlanOpenRequest] = useState<object | undefined>();
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [asyncQuestion, setAsyncQuestion] = useState<AsyncQuestionRecord>({
    questionId: "fixture-async-question-1",
    requestId: "fixture-request-1",
    threadId: owner.threadId,
    sourceTurnId: "fixture-source-turn",
    toolCallId: "fixture-tool-call",
    revision: 0,
    createdAtMs: NOW,
    status: "pending",
    questions: [{
      id: new URLSearchParams(location.search).get("questionItemId") ?? "delivery-mode",
      header: "交付方式",
      question: "这个改动完成后，如何安排提交？",
      options: [
        { id: "review", label: "先创建草稿供我审阅", description: "保留提交前检查。" },
        { id: "hold", label: "只保存本地改动", description: "暂不创建草稿。" },
      ],
      multiSelect: name === "async-question-answer-keys",
    }],
  });
  const [asyncQuestionConnected, setAsyncQuestionConnected] = useState(true);
  const [asyncQuestionConfirmed, setAsyncQuestionConfirmed] = useState(true);
  const finishOriginalAnswer = useRef<(() => void) | null>(null);
  const [agentDraft, setAgentDraft] = useState("");
  const [agentHistory, setAgentHistory] = useState(false);
  const status = name === "agent-steer" || name === "agent-question" ? "running" : name.slice(6);
  const agents: AgentSummary[] = name === "agent-empty" ? [] : [
    { agentId: "layout-agent", agentName: "布局检查助手", status: status || "running", acceptingMessages: status === "running", queueDepth: 0 },
    { agentId: "review-agent", agentName: "交互与无障碍复核", status: "done", acceptingMessages: false, queueDepth: 0 },
    { agentId: "docs-agent", agentName: "文档整理助手", status: "paused", acceptingMessages: false, queueDepth: 0 },
  ];
  const agent = agents.find(row => row.agentId === selectedAgent);
  const agentText = name === "agent-failed" ? "## 本次检查未完成\n\n读取目标文件时发生错误，已停止本次检查。已有记录保留，请先核对文件访问权限。"
    : name === "agent-cancelled" ? "## 检查已取消\n\n已保留取消前的公开记录，没有继续执行后续修改。"
    : "## 布局检查记录\n\n已检查会话标题、长文阅读与底部输入区。\n\n- 子代理从父会话的更多菜单进入。\n- 选择代理后查看它的公开记录。\n- 返回父会话时保留原来的输入与阅读内容。\n\n### 下一步\n\n继续核对窄屏与深色主题下的菜单、返回和正文排版。";
  const planVisible = name.startsWith("plan") && name !== "plan-none";
  const running = name === "provider-retry" || name === "thinking-running" || name === "running" || name === "agent-running" || (name.startsWith("plan") && name !== "plan-ended" && name !== "plan-idle");
  const connectionScenario = name.startsWith("connection-");
  const connected = name !== "offline" && name !== "goal-offline" && (!connectionScenario || name === "connection-restored");
  const snapshot: any = { threadId: owner.threadId, title: fixtureTitle, cwd, connected, configurationReady: connected,
    running, activeTurnId: running ? "turn" : null, messages: [], hasMoreBefore: false, beforeCursor: null, loadingOlder: false,
    interaction: null, error: null, permissionMode: "default", ...modelPreference };
  if (connectionScenario && !connected) {
    snapshot.connectionPhase = name === "connection-unknown" ? "reconnecting" : name.slice(11);
    snapshot.error = "与 KCoder app-server 的连接已断开，正在重新连接…";
    if (name === "connection-failed") snapshot.error = "目标连接失败，已停止自动重连。可重试连接；其他目标仍保持登录。";
    if (name === "connection-reauthorization-required") snapshot.error = "Gateway 会话已失效，请前往设置重新连接";
    if (name === "connection-unknown") snapshot.sendAcceptanceUnknown = true;
  }
  if (name.startsWith("goal-")) snapshot.goal = { ...goal, status: ["edit", "details"].includes(name.slice(5)) ? "paused" : ["goal-offline", "goal-unknown"].includes(name) ? "active" : name.slice(5),
    mode: name === "goal-pro" ? "strict" : "continuous", ...(name === "goal-pro" ? { status: "active" } : {}),
    ...(name === "goal-blocked" ? { blockerReason: "需要用户确认目标目录后才能继续。" } : {}) };
  if (name === "goal-unknown") snapshot.goalMutationUnknown = true;
  const task: any = { snapshot, getSnapshot: () => snapshot, subscribe: () => noop, clientGeneration: 1,
    getGoal: async () => snapshot.goal ?? null, patch: noop, updateGoalStatus: asyncNoop, clearGoal: asyncNoop, editGoal: asyncNoop,
    interrupt: asyncNoop, agentCapabilities: () => ({ discover: true }), rename: async (title: string) => setFixtureTitle(title), compact: async () => ({ compacted: false }),
    reconnectNow: async () => setName("connection-restored"), reconcileSendAcceptance: asyncNoop,
    canSetPermissionMode: () => true, continuationState: () => ({ allowed: name === "provider-failed", unknown: false }), continueFailed: async () => setName("provider-continued"), supportsCurrentConfigurationContinuation: () => false, isDisposed: () => false };
  const sendPhase = name.startsWith("send-") ? name.slice(5) : "none";
  const pending = ["preparing", "retaining", "sending"].includes(sendPhase);
  const submission: any = { id: "synthetic-send", content: "请帮我检查这个项目。", attachments: [], createdAt: NOW,
    outcome: ["sending", "unknown", "accepted"].includes(sendPhase) ? "unknown" : "failed", retrying: pending,
    phase: sendPhase === "preparing" ? "preparing" : sendPhase === "retaining" ? "retaining" : "sending",
    ...(sendPhase === "accepted" ? { acceptedTurn: { threadId: owner.threadId, turnId: "turn" } } : {}),
    ...(sendPhase.startsWith("failed") ? { error: "示例：服务器明确拒绝了本次发送。".repeat(sendPhase === "failed-many" ? 8 : 1) } : {}) };
  const model: any = { task, snapshot, input, setInput, messageInputRef: inputRef, attachments: [], canSend: false,
    attachmentSheet: false, modelPickerOpen: false, failedSubmissions: sendPhase === "none" ? [] : sendPhase === "failed-many"
      ? Array.from({ length: 4 }, (_, index) => ({ ...submission, id: `synthetic-send-${index}`, content: `${index + 1}. ${submission.content}` })) : [submission],
    retainedOutbox: { rows: [], error: null, busy: [], available: false, resume: asyncNoop, checkConsumer: asyncNoop, discard: asyncNoop },
    removeAttachment: asyncNoop, openAttachmentSheet: noop, setQueueError: noop, setComposerNotice: noop, submit: asyncNoop,
    retryFailedSubmission: asyncNoop, checkFailedSubmission: asyncNoop,
    dismissFailedSubmission: () => setName("reply"), removeFailedSubmissionAttachment: asyncNoop };
  const reply: any = { id: "reply", role: "assistant", turnId: "turn", timestampMs: NOW, status: running ? "streaming" : name === "thinking-stopped" ? "interrupted" : "completed",
    content: name.startsWith("thinking-") ? "" : name === "plan-scroll" ? Array.from({ length: 5 }, (_, i) => `## 检查记录 ${i + 1}\n\n${REPLY}`).join("\n\n") : REPLY,
    ...(planVisible ? { todos: name === "plan-ended" ? todos.map(todo => ({ ...todo, status: "completed" }))
      : name === "plan-cancelled" ? [...todos, { content: "取消额外的装饰调整", status: "cancelled" }]
      : name === "plan-many" ? [...todos, ...Array.from({ length: 12 }, (_, i) => ({ content: `补充检查项 ${i + 1}`, status: "pending" }))] : todos } : {}),
    ...(name.startsWith("thinking-") ? { thinking: "我先检查当前会话、项目归属和输入区的可用操作，再逐项核对布局。" } : {}) };
  let previousFailure: any;
  if (name.startsWith("provider-")) {
    const error = "Provider error: unknown_error; HTTP 503. Response details withheld.";
    const retryBlocks = [1, 2, 3].map(attempt => ({ kind: "activity", id: `retry-${attempt}`, activity: { id: `retry-${attempt}`, type: "notice", label: `Provider main request failed for fixture model model-a (${error}); retrying ${attempt}/3 after 1082ms...`, status: "completed" } }));
    const failed = { ...reply, id: "provider-failure", content: "", status: "failed", error, attemptId: "attempt-1",
      providerFailure: { category: "provider_error", recovery_action: "diagnose_only", retryable: true, resume_safe: true, http_status: 503 },
      orderedBlocks: [...retryBlocks, { kind: "activity", id: "runtime-error", activity: { id: "runtime-error", type: "activity", label: "运行失败", detail: error, status: "failed" } }] };
    if (name === "provider-continued") previousFailure = { ...failed, continuedByAttemptId: "attempt-2" };
    else if (name === "provider-failed") Object.assign(reply, failed);
    else Object.assign(reply, { content: name === "provider-completed" ? "The model service recovered and returned this reply." : "", orderedBlocks: name === "provider-completed" ? [...retryBlocks, { kind: "text", id: "resumed-reply", content: "The model service recovered and returned this reply." }] : retryBlocks });
  }
  if (planVisible) snapshot.messages = [reply];
  const previousReply: any = { id: "previous-plan", role: "assistant", turnId: "previous-turn", content: "上一轮检查记录。", timestampMs: NOW - 1000,
    todos: [{ content: "上一轮已完成的检查", status: "completed" }, { content: "上一轮已取消的检查", status: "cancelled" }] };
  const server: any = { id: "api", label: "CYX 服务器", transport: "local", workspacePath: cwd };
  const projects: any[] = ["用户中心", "产品文档"].map((label, index) => ({ key: `project-${index}`, projectKey: `project-${index}`, name: label, pinned: index === 0,
    rootProject: false, workspaces: [{ key: `workspace-${index}`, identity: `workspace-${index}`, projectKey: `project-${index}`, projectName: label,
      rootProject: false, path: `${cwd}/${index}`, label, kind: "workspace", threads: name === "selection-empty" ? [] : [
        { id: `thread-${index}`, title: index ? "产品 PRD 第三节修订" : "重构用户中心里的 Gateway 鉴权", updatedAt: NOW - index * 3600000, cwd },
        { id: `thread-b-${index}`, title: "JWT 异常码统一规范", updatedAt: NOW - 7200000, cwd },
      ] }] }));
  const question: any = { kind: "question", requestId: 1, questionId: "question", owner, responding: name === "question-submitting",
    ...(name === "agent-question" ? { sourceAgent: { parentSessionId: owner.threadId, agentId: "layout-agent" } } : {}),
    questions: [{ id: "layout", header: "确认设计范围", prompt: "这次优先检查哪些区域？", multiSelect: name === "question-multi", allowsFreeform: true,
      options: [{ label: "会话正文", value: "body", description: "检查消息、思考和工具展示。" }, { label: "底部输入区", value: "input", description: "检查模型、附件与发送状态。" }] }] };
  const attachmentOpen = name.startsWith("attachment-");
  const modelOpen = name.startsWith("model-");
  const fixtureModels = [
    { id: "layout-model", model: "layout-model", providerId: "layout", displayName: "布局检查模型", providerName: "示例服务", supportsVision: true, supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    { id: "compact-model", model: "compact-model", providerId: "layout", displayName: "轻量检查模型", providerName: "示例服务", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
    { id: "plain-model", model: "plain-model", providerId: "layout", displayName: "基础检查模型", providerName: "示例服务" },
  ];
  const interactions: any = { snapshot, bottomInset: 0, attachmentSheet: attachmentOpen,
    attachmentLoading: name === "attachment-preparing", attachmentError: name === "attachment-error" ? "示例：附件准备失败，原文件仍保留。" : null,
    modelPickerOpen: modelOpen, modelsLoading: name === "model-loading", modelBusy: false,
    modelError: name === "model-error" ? "示例：暂时无法读取当前目标的模型列表。" : null,
    modelOptions: ["model-empty", "model-loading", "model-error"].includes(name) ? [] : fixtureModels,
    selectedModelOption: fixtureModels.find(item => item.model === modelPreference.model || `${item.providerId}::${item.model}` === modelPreference.model),
    closeAttachmentSheet: noop, attachmentSheetRef: null, closeModelPicker: () => setName("reply"),
    pickFile: asyncNoop, pickImage: asyncNoop, takePhoto: asyncNoop,
    applyTurnPreferences: async (model: string, reasoningEffort?: string) => { setModelPreference({ model, reasoningEffort }); return true; } };
  return <NavigationContext.Provider value={NAV as any}><SafeAreaProvider>
    <View testID="current-v3-fixture" dataSet={{ scenario: name }} style={{ flex: 1, backgroundColor: colors.background }}>
      {name.startsWith("selection") ? <>
        <V3ConversationSelectionHeader pendingCount={name === "selection-empty" ? 0 : 2} onSearch={noop} onInbox={noop} onSettings={noop} />
        <ScrollView><V3ConversationSelection targets={[{ server, projects, enabled: true, status: "online", hasMore: false }]} collapsed={collapsed} collapseReady
          onToggle={id => collapse(previous => previous.has(id) ? new Set() : new Set([id]))} onNew={noop} onAddProject={noop}
          onThread={noop} onThreadActions={noop} onProjectActions={noop} onProjectPinToggle={asyncNoop} onViewAll={noop} /></ScrollView>
      </> : <>
        <ConversationV3Background />
        <ConversationV3Header title={name === "draft" ? "" : snapshot.title} subtitle={name === "draft" ? undefined : server.label}
          onBack={() => setName("selection")} onNew={noop} onMore={() => setMenuOpen(true)} navigation={{ projects: () => setName("selection") }} />
        {name.startsWith("search-") ? <TranscriptSearchBar query={name === "search-empty" ? "没有的词" : "项目"} onQuery={noop}
          matches={name === "search-empty" ? [] : [{ excerpt: "当前项目的会话、权限与附件使用同一套控制器。" }] as any} total={name === "search-empty" ? 0 : 1} index={0} onStep={noop} onClose={noop} /> : null}
        <ScrollView ref={transcriptRef} testID="fixture-transcript" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 12 }}>
          {name.startsWith("async-question") ? <Text testID="async-question-fixture-context" style={{ color: colors.textMuted, padding: 12 }}>
            有一个可稍后回答的问题。
          </Text>
            : name === "draft" ? <View style={{ alignItems: "center", marginTop: 100 }}><ConversationV3WelcomeMark /></View>
            : name === "preferences" ? <ConversationPreferencesSettings />
            : name.startsWith("phrases") ? <QuickPhrasesSettings />
            : <>{name === "plan-history" ? <MessageBubble message={previousReply} readOnly connected continuationBusy={false} onOpenFile={() => false} onOpenChanges={noop} /> : null}
              <MessageBubble message={{ id: "question", role: "user", content: "请检查这个项目的界面布局。", timestampMs: NOW } as any} readOnly connected continuationBusy={false} onOpenFile={() => false} onOpenChanges={noop} />
              {previousFailure ? <MessageBubble message={previousFailure} task={task} connected={connected} continuationBusy={false} onOpenFile={() => false} onOpenChanges={noop} /> : null}
              <MessageBubble message={reply} task={task} turnRunning={running} connected={connected} continuationBusy={false} onOpenFile={() => false} onOpenChanges={noop} onFork={noop} />
              {connectionScenario ? <TaskRuntimeError snapshot={snapshot} task={task} connectionNoticeOwned /> : null}
            </>}
        </ScrollView>
        {connectionScenario ? <TaskConnectionNotice snapshot={snapshot} onReconnect={task.reconnectNow} onReauthorize={noop} /> : null}
        {name.startsWith("approval-") ? <ApprovalCard interaction={{ kind: "approval", requestId: 1, approvalId: "approval", owner,
          reason: "工具需要读取当前项目文件。", action: name === "approval-incomplete" ? { type: "tool", name: "read" } : { type: "tool", name: "read", input: { file_path: "/workspace/user-center/README.md" } },
          responding: name === "approval-submitting" }} onRespond={noop} /> : null}
        {name.startsWith("question-") ? <QuestionCard interaction={question} onSubmit={noop} onCancel={noop} disabled={name === "question-readonly"} /> : null}
        {name === "async-question-owner-switch" || name === "async-question-reconnect" ? <View>
          <Button testID="async-question-switch-owner" onPress={() => setAsyncQuestion(current => ({
            ...current, threadId: "replacement-thread",
          }))}>Switch fixture task</Button>
          <Button testID="async-question-finish-original" onPress={() => finishOriginalAnswer.current?.()}>
            Finish original fixture receipt
          </Button>
        </View> : null}
        {name === "async-question-connection" || name === "async-question-reconnect" ? <Button testID="async-question-toggle-connection"
          onPress={() => {
            setAsyncQuestionConnected(value => !value);
            if (name === "async-question-connection") setAsyncQuestionConfirmed(false);
          }}>
          {asyncQuestionConnected ? "Disconnect fixture" : "Reconnect fixture"}
        </Button> : null}
        {name === "async-question-connection" && asyncQuestionConnected && !asyncQuestionConfirmed ? <Button
          testID="async-question-confirm-readback" onPress={() => setAsyncQuestionConfirmed(true)}>
          Confirm fixture question list
        </Button> : null}
        {name.startsWith("async-question") ? <AsyncQuestionCard
          question={asyncQuestion}
          disabled={!asyncQuestionConnected || !asyncQuestionConfirmed}
          onAnswer={async input => {
            if (name === "async-question-reconnect") {
              if (finishOriginalAnswer.current) throw new Error("Synthetic current task receipt unknown");
              await new Promise<void>((resolve, reject) => {
                finishOriginalAnswer.current = () => new URLSearchParams(location.search).get("receipt") === "failure"
                  ? reject(new Error("Synthetic old connection lost")) : resolve();
              });
              return;
            }
            if (name === "async-question-owner-switch") {
              if (asyncQuestion.threadId === owner.threadId)
                await new Promise<void>(resolve => { finishOriginalAnswer.current = resolve; });
              else throw new Error("Synthetic current task receipt unknown");
              return;
            }
            setAsyncQuestion(current => ({
              ...current,
              revision: current.revision + 1,
              status: "answer_saved",
              answer: { submissionId: input.submissionId, answers: input.answers, acceptedAtMs: NOW },
            }));
            if (name === "async-question-lost-receipt") throw new Error("Synthetic answer receipt lost");
          }}
          onCancel={async () => setAsyncQuestion(current => ({ ...current, revision: current.revision + 1, status: "cancelled" }))}
          onRefresh={noop}
        /> : null}
        {name === "draft" ? <ConversationV3Scope server={server.label} cwd={cwd} connected={connected} onNavigate={noop} /> : null}
        <View testID="fixture-composer-dock" style={{ flexShrink: 0 }}>
        <TaskPlanControls owner={planOwner.current} snapshot={snapshot} openRequest={planOpenRequest} />
        {name.startsWith("goal-") || planVisible ? <TaskGoalControls task={task} snapshot={snapshot} /> : null}
        <TaskComposer model={model} variant={name === "draft" || name === "offline" ? "draft" : "conversation"} draftEditable={name === "offline"}
          aboveComposer={name.includes("jump") && latestDismissedFor !== name ? <JumpToLatestButton inComposer model={{
            messageListRef: transcriptRef as any, messageFollowState: followState, webPrependAnchor: prependAnchor,
            snapshot: { messages: [reply] }, setShowJumpToLatest: () => dismissLatest(name),
          }} /> : undefined}
          quickPhrasesOpenRequest={name === "quick-picker" ? NAV : undefined}
          toolbar={<ComposerMetaRow permissionSelector={null} status={null}
            modelSelector={<Pressable testID="fixture-model-selector" onPress={() => setName("model-picker")} style={{ minHeight: 32, paddingHorizontal: 12, justifyContent: "center", borderRadius: 18, backgroundColor: colors.surface }}><Text style={{ color: colors.textMuted }}>{interactions.selectedModelOption?.displayName ?? "布局检查模型"}</Text></Pressable>} />} />
        </View>
        <TaskInteractions model={interactions} />
        <TaskMenu visible={menuOpen} task={task} demo={false} onClose={() => setMenuOpen(false)} onArchived={noop} onDeleted={noop}
          onPlan={() => setPlanOpenRequest({})}
          onSubagents={() => { setMenuOpen(false); setSelectedAgent(null); setSubagentsOpen(true); }} onSearch={noop} onWorkspace={noop} onQuickPhrases={noop} onPermission={noop} />
        <TaskPermissionSheet visible={name === "permissions" || name === "permissions-disabled"} supported selected="default" canChange={name !== "permissions-disabled"} error={null} onClose={noop} onSelect={noop} />
        <PanelMenu visible={name === "workspace-menu"} canAdd onClose={noop} onAdd={noop} />
        <SessionFiltersPage visible={name === "filters"} owner="synthetic" value={{ serverId: "all", workspaceKey: null, archived: false }}
          servers={[{ id: "api", label: server.label, count: 4 }]} projects={projects.map(p => ({ key: p.key, serverId: "api", label: p.name, path: cwd, serverLabel: server.label, count: 2 }))} onClose={noop} onApply={noop} />
      </>}
      <TaskSubagentPanel visible={subagentsOpen} onBack={() => selectedAgent ? setSelectedAgent(null) : setSubagentsOpen(false)}
        onRefresh={noop} refreshDisabled bottomInset={0} title={agent?.agentName} scrollable={!agent}
        onHistory={agent && !agentHistory ? () => setAgentHistory(true) : undefined}
        onLive={agent && agentHistory ? () => setAgentHistory(false) : undefined}
        historyDisabled={false}
        information={agent ? { agentId: agent.agentId, directory: cwd, goal: agent.presentation?.goal } : undefined}>
        {agent ? <TaskSubagentConversation key={agent.agentId} agent={agent} history={agentHistory}
          page={agentHistory ? { threadId: owner.threadId, agentId: agent.agentId, content: agentText } : null}
          view={agentHistory ? undefined : { loading: false, snapshot: { ...snapshot, threadId: agent.agentId, connected: true,
            running: agent.status === "running", activeTurnId: agent.status === "running" ? "child-assistant" : null,
            messages: [
              { id: "child-user", role: "user", content: "请检查会话布局。", timestampMs: 1 },
              { id: "child-assistant", turnId: "child-assistant", role: "assistant", content: agentText, timestampMs: 2,
                status: agent.status === "running" ? "streaming" : "completed",
                orderedBlocks: [
                  { kind: "thinking", id: "child-thinking", content: "检查标题、正文和输入区的布局。" },
                  { kind: "tool", id: "child-tool", name: "Read", status: "completed", output: "已读取页面组件。" },
                  { kind: "text", id: "child-text", content: agentText },
                ] },
            ],
          } }}
          parentTitle={snapshot.title} targetLabel={server.label} directory={cwd}
          onParent={() => { setSelectedAgent(null); setSubagentsOpen(false); }}
          controls={name === "agent-question" ? <QuestionCard interaction={question} onSubmit={noop} onCancel={noop} disabled /> : null}
          composer={agentHistory ? undefined : { value: agentDraft, onChange: setAgentDraft, disabled: false, canSend: false, onSend: noop,
            label: t("task.send_instruction"), running: agent.status === "running", bottomInset: 0 }} /> : <TaskSubagentList agents={agents} onChoose={id => { setAgentHistory(false); setSelectedAgent(id); }} pendingCount={id => name === "agent-question" && id === "layout-agent" ? 1 : 0} />}
      </TaskSubagentPanel>
    </View>
  </SafeAreaProvider></NavigationContext.Provider>;
}

import React from "react";
import { createRequire } from "node:module";
import { expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { CachedTaskComposer, TaskComposer } from "./TaskComposer";
import { NewTaskDraft } from "./NewTaskDraft";
import { WorkspaceTabSwitcher } from "@/components/workspace-tab-switcher";
import { ChangesPanel } from "@/components/changes-panel";
import { FailureContinuation } from "@/components/failure-continuation";
import { TaskDisplayHeader, TaskHeader } from "./TaskHeader";
import { RuntimeErrorBanner } from "./RuntimeErrorBanner";
import { ApprovalCard, QuestionCard } from "@/components/interaction-cards";
vi.hoisted(() => { Object.defineProperty(globalThis, "__DEV__", { value: false, configurable: true }); });
const interfaceState = vi.hoisted(() => ({ version: "modern" }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => interfaceState.version }));
vi.mock("@/features/interface/ConversationV3", () => ({ ConversationV3Background: () => null, ConversationV3WelcomeMark: () => null, ConversationV3Header: "ConversationV3Header" }));
const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };
test("an unsent conversation reuses the composer without runtime-only controls", () => {
  initLocale("en");
  const markup = renderToStaticMarkup(<NewTaskDraft cwd="/workspace/project" input="First message"
    setInput={vi.fn()} ready busy={false} modelLabel="Target model" reasoningEffort="high"
    bottomInset={0} modelPickerOpen={false} openModelPicker={vi.fn()} submit={vi.fn(async () => {})} />);
  expect(markup).toContain('data-testid="new-task-draft"');
  expect(markup).toContain('data-testid="message-input"');
  expect(markup).not.toContain('data-testid="composer-quick-phrases"');
  expect(markup).toContain('data-testid="draft-model-selector"');
  expect(markup).not.toContain('data-testid="composer-attachment"');
  expect(markup).not.toContain('data-testid="stop-turn"');
  const blocked = renderToStaticMarkup(<NewTaskDraft cwd="/workspace/project" input="First message"
    setInput={vi.fn()} ready busy={false} expertSendLocked modelLabel="Target model" reasoningEffort="high"
    bottomInset={0} modelPickerOpen={false} openModelPicker={vi.fn()} submit={vi.fn(async () => {})} />);
  expect(blocked.match(/<[^>]+data-testid="send-message"[^>]*>/)?.[0]).toContain('aria-disabled="true"');
});

test("cached conversation keeps the shared header and composer layout with runtime actions disabled", () => {
  initLocale("en");
  const header = renderToStaticMarkup(<TaskDisplayHeader title="Cached title" status="Cached · read only"
    connected={false} onBack={vi.fn()} disabledActions={{ menu: true, new: true, more: true }} />);
  const draft = "Preserved draft\nline two\nline three\nline four\nline five\nline six\nline seven";
  const composer = renderToStaticMarkup(<CachedTaskComposer draft={draft} bottomInset={0} offline />);
  const liveComposer = renderToStaticMarkup(<TaskComposer model={{
    task: { interrupt: vi.fn() }, retainedOutbox: { rows: [], error: null },
    snapshot: { connected: true, running: false }, input: draft, attachments: [],
    setInput: vi.fn(), setQueueError: vi.fn(), setComposerNotice: vi.fn(),
    openAttachmentSheet: vi.fn(), removeAttachment: vi.fn(), submit: vi.fn(),
    canSend: false, failedSubmissions: [],
  } as never} />);
  const areaOpeningTag = (markup: string) => markup.match(/<[^>]+data-testid="message-input-area"[^>]*>/)?.[0];
  expect(header).toContain('data-testid="task-header"');
  expect(header).toContain('data-testid="task-header-title"');
  expect(header).toContain('aria-label="Open task list"');
  expect(header).toContain('aria-label="New conversation"');
  expect(header).toContain('aria-label="More"');
  expect(header.match(/aria-disabled="true"/g)).toHaveLength(3);
  expect(header).toMatch(/r-opacity-[^\s"]+/);
  expect(composer).toContain('data-testid="message-input"');
  expect(composer).toContain("line seven");
  expect(composer).toContain("height:129px");
  expect(composer).toContain('data-testid="composer-toolbar"');
  expect(composer).toContain('data-testid="composer-attachment"');
  expect(composer).not.toContain('data-testid="composer-quick-phrases"');
  expect(composer).toContain('data-testid="send-message"');
  expect(composer).toContain('data-testid="cached-session-model-selector"');
  expect(composer).toContain('data-testid="cached-session-permission-selector"');
  expect(composer).not.toContain('data-testid="cached-session-expert-selector"');
  expect(composer).toContain('data-testid="cached-session-model-label"');
  expect(composer).toContain('data-testid="cached-session-permission-label"');
  expect(composer).toContain('data-testid="cached-session-connection-label"');
  expect(composer.match(/aria-disabled="true"/g)).toHaveLength(4);
  expect(composer).toContain("Model after reconnect");
  expect(composer).toContain("Permissions after reconnect");
  expect(composer).toContain(">Model</div>");
  expect(composer).toContain(">Permissions</div>");
  expect(composer).toContain(">Offline</div>");
  expect(areaOpeningTag(composer)).toBe(areaOpeningTag(liveComposer));
});

// Native attachment IO is outside this SSR accessibility test.
vi.mock("expo-file-system", () => ({ File: class File {} }));
vi.mock("expo-file-system/legacy", () => ({ cacheDirectory: "/fixture", EncodingType: { Base64: "base64" }, deleteAsync: vi.fn(), writeAsStringAsync: vi.fn() }));
vi.mock("expo-sharing", () => ({ shareAsync: vi.fn(), isAvailableAsync: vi.fn(async () => false) }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ArrowUp",
      "Send",
      "Plus",
      "Paperclip",
      "Sparkles",
      "Square",
      "ChevronLeft",
      "FileCode2",
      "CirclePlus",
      "UserRound",
      "MoreHorizontal",
      "PanelLeft",
      "SlidersHorizontal",
      "ShieldCheck",
      "Shield",
      "Ban",
      "ShieldQuestion",
      "ShieldOff",
      "ShieldX",
      "FilePenLine",
      "Flame",
      "CheckSquare",
      "HelpCircle",
      "ExternalLink",
      "ChevronDown",
      "GitBranch",
      "GitCompareArrows",
      "GitMerge",
      "Download",
      "Upload",
      "RefreshCw",
      "RotateCcw",
      "Bot",
      "Check",
      "Globe2",
      "Plus",
      "TerminalSquare",
      "X",
    ].map((name) => [name, () => null]),
  ),
);

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/storage/app-preferences", () => ({
  getAppPreferencesSnapshot: () => ({ quickPhrases: [] }),
  subscribeAppPreferences: () => () => {},
}));

test.each([false, true])(
  "keeps quick phrases out of the collapsed input row (running=%s)",
  (running) => {
    initLocale("en");
    const model = {
      task: { interrupt: vi.fn() },
      retainedOutbox: { rows: [], error: null },
      snapshot: { connected: true, running },
      input: "",
      attachments: [],
      setInput: vi.fn(),
      setQueueError: vi.fn(),
      setComposerNotice: vi.fn(),
      openAttachmentSheet: vi.fn(),
      removeAttachment: vi.fn(),
      submit: vi.fn(),
      canSend: false,
      failedSubmissions: [],
    };
    const collapsed = renderToStaticMarkup(
      <TaskComposer model={model as never} />,
    );
    expect(collapsed).toContain('data-testid="composer-attachment"');
    expect(collapsed).toContain('data-testid="message-input"');
    expect(collapsed).toContain(
      `data-testid="${running ? "queue-message" : "send-message"}"`,
    );
    expect(collapsed.includes('data-testid="stop-turn"')).toBe(running);
    expect(collapsed).not.toContain('data-testid="composer-quick-phrases"');

    const expanded = renderToStaticMarkup(
      <TaskComposer model={{ ...model, input: "draft" } as never} />,
    );
    expect(expanded).toContain('data-testid="composer-attachment"');
    expect(expanded).not.toContain('data-testid="composer-quick-phrases"');
  },
);

test.each([
  [
    "en",
    "Add attachment",
    "Send",
    "Queue message",
    "Stop",
    "Retry connection",
    "Approval required",
    "Allow once",
    "Submit answers",
    "Working",
  ],
  [
    "zh-CN",
    "添加附件",
    "发送",
    "排队发送",
    "停止",
    "重试连接",
    "需要审批",
    "允许一次",
    "提交回答",
    "正在处理",
  ],
] as const)(
  "%s task controls render localized text and accessible names",
  (
    locale,
    add,
    send,
    queue,
    stop,
    retry,
    approval,
    allow,
    answers,
    working,
  ) => {
    initLocale(locale);
    const model = {
      task: { interrupt: vi.fn() },
      retainedOutbox: { rows: [], error: null },
      snapshot: { connected: true, running: false },
      input: "draft",
      attachments: [],
      setInput: vi.fn(),
      setQueueError: vi.fn(),
      setComposerNotice: vi.fn(),
      openAttachmentSheet: vi.fn(),
      removeAttachment: vi.fn(),
      submit: vi.fn(),
      canSend: true,
      failedSubmissions: [],
    };
    const idle = renderToStaticMarkup(<TaskComposer model={model as never} />);
    expect(idle).toContain(`aria-label="${add}"`);
    expect(idle).toContain(`aria-label="${send}"`);
    const running = renderToStaticMarkup(
      <TaskComposer
        model={
          { ...model, snapshot: { connected: true, running: true, activeTurnId: "turn-localization", stopRequestedTurnId: null } } as never
        }
      />,
    );
    expect(running).toContain(`aria-label="${queue}"`);
    expect(running).toContain(`aria-label="${stop}"`);
    const error = renderToStaticMarkup(
      <RuntimeErrorBanner error="HTTP 401" onReconnect={async () => {}} />,
    );
    expect(error).toContain(retry);
    const approvalHtml = renderToStaticMarkup(
      <ApprovalCard
        interaction={
          {
            kind: "approval",
            requestId: 1,
            approvalId: "approval",
            reason: "server reason",
            action: { toolName: "Bash", input: { command: "pwd" } },
            owner: {
              profileId: "profile-fixture",
              profileAuthorizationScopeKey: "scope-fixture",
              serverId: "target-fixture",
              appServerId: "app-server-fixture",
              serverConfigIdentity: "server-config-fixture",
              threadId: "thread-fixture",
              turnId: "turn-fixture",
              appServerEpoch: "epoch-fixture",
              runtimeInstanceNonce: 1,
              profileActivationEpoch: 1,
              originClientGeneration: 1,
              status: "pending",
            },
          } as never
        }
        onRespond={vi.fn()}
      />,
    );
    expect(approvalHtml).toContain(approval);
    expect(approvalHtml).toContain(allow);
    expect(approvalHtml).toContain("server reason");
    const questionHtml = renderToStaticMarkup(
      <QuestionCard
        interaction={
          {
            kind: "question",
            requestId: 2,
            questionId: "question",
            questions: [
              {
                id: "q",
                header: "server header",
                prompt: "server prompt",
                options: [],
                allowsFreeform: true,
              },
            ],
            owner: {
              profileId: "profile-fixture",
              profileAuthorizationScopeKey: "scope-fixture",
              serverId: "target-fixture",
              appServerId: "app-server-fixture",
              serverConfigIdentity: "server-config-fixture",
              threadId: "thread-fixture",
              turnId: "turn-fixture",
              appServerEpoch: "epoch-fixture",
              runtimeInstanceNonce: 1,
              profileActivationEpoch: 1,
              originClientGeneration: 1,
              status: "pending",
            },
          } as never
        }
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(questionHtml).toContain(answers);
    expect(questionHtml).toContain("server prompt");
    const snapshot = {
      connected: true,
      running: true,
      title: "fixture task",
      cwd: "/workspace",
    };
    const header = renderToStaticMarkup(
      <TaskHeader
        task={
          { subscribe: () => () => {}, getSnapshot: () => snapshot } as never
        }
        onBack={vi.fn()}
        onMenu={vi.fn()}
        onMore={vi.fn()}
      />,
    );
    expect(header).toContain(working);
  },
);

test.each([
  ["en", "Continue after failure"],
  ["zh-CN", "从失败处继续"],
] as const)(
  "%s failed-turn recovery renders a localized action",
  (locale, action) => {
    initLocale(locale);
    const task = {
      continuationState: () => ({ allowed: true, unknown: false }),
      getSnapshot: () => ({ model: "fixture" }),
      supportsCurrentConfigurationContinuation: () => false,
    };
    const html = renderToStaticMarkup(
      <FailureContinuation
        task={task as never}
        message={{ id: "failed", error: "raw server detail", providerFailure: { category: "network_error", recovery_action: "diagnose_only", retryable: true, resume_safe: true } } as never}
        busy={false}
        connected
      />,
    );
    expect(html).toContain(action);
  },
);

test.each([
  ["en", "Working tree", "Staged"],
  ["zh-CN", "工作树", "已暂存"],
] as const)(
  "%s changes panel renders localized task workspace controls",
  (locale, working, staged) => {
    initLocale(locale);
    const snapshot = {
      cwd: "/workspace",
      messages: [],
      connected: true,
      running: false,
    };
    const task = { subscribe: () => () => {}, getSnapshot: () => snapshot };
    const html = renderToStaticMarkup(
      <ChangesPanel task={task as never} demo={false} onOpenFile={vi.fn()} />,
    );
    expect(html).toContain(working);
    expect(html).toContain(staged);
  },
);

test("English task tabs localize restored default labels while preserving file names", () => {
  initLocale("en");
  const props: React.ComponentProps<typeof WorkspaceTabSwitcher> = {
    panels: [{ id: "agent", kind: "agent", title: "智能体" }],
    activePanelId: "agent",
    open: false,
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onAdd: vi.fn(),
  };
  const defaultHtml = renderToStaticMarkup(<WorkspaceTabSwitcher {...props} />);
  expect(defaultHtml).toContain("Agent");
  expect(defaultHtml).not.toContain("智能体");
  const fileHtml = renderToStaticMarkup(
    <WorkspaceTabSwitcher
      {...props}
      panels={[{ id: "files-1", kind: "files", title: "用户文件.ts" }]}
      activePanelId="files-1"
    />,
  );
  expect(fileHtml).toContain("用户文件.ts");
});


test.each([
  ["en", "Message accepted; syncing history", "Sync message record 1", "Remove accepted message notice 1"],
  ["zh-CN", "消息已接收，正在同步记录", "同步消息记录 1", "移除已接收消息提示 1"],
] as const)("%s accepted recovery stays check-only while idle and checking", (locale, title, check, dismiss) => {
  initLocale(locale);
  for (const retrying of [false, true]) {
    const model = {
      task: { interrupt: vi.fn() }, retainedOutbox: { rows: [], error: null },
      snapshot: { threadId: "thread-1", connected: true, running: false }, input: "", attachments: [], canSend: false,
      failedSubmissions: [{ id: "composer-accepted", content: "original", attachments: [], createdAt: 1,
        outcome: "unknown", retrying, acceptedTurn: { threadId: "thread-1", turnId: "turn-1" } }],
    };
    const html = renderToStaticMarkup(<TaskComposer model={model as never} />);
    expect(html).toContain(title);
    expect(html).toContain(`aria-label="${check}"`);
    expect(html).toContain(`aria-label="${dismiss}"`);
    expect(html).toContain('data-testid="verify-failed-submission"');
    expect(html).not.toContain('data-testid="retry-failed-submission"');
    expect(html).not.toContain(locale === "en" ? "Send status needs checking" : "发送状态待核对");
  }
});


test.each([undefined, { threadId: "foreign-thread", turnId: "turn-1" }])("an absent or foreign accepted observation keeps the legacy unknown presentation", acceptedTurn => {
  initLocale("en");
  const model = { task: { interrupt: vi.fn() }, retainedOutbox: { rows: [], error: null },
    snapshot: { connected: true, running: false }, input: "", attachments: [], canSend: false,
    failedSubmissions: [{ id: "composer-legacy", content: "original", attachments: [], createdAt: 1,
      outcome: "unknown", retrying: false, ...(acceptedTurn ? { acceptedTurn } : {}) }] };
  const html = renderToStaticMarkup(<TaskComposer model={model as never} />);
  expect(html).toContain("Send status needs checking");
  expect(html).not.toContain("Message accepted; syncing history");
});

test.each([
  ["en", "Preparing message; recovery record saved", "Preparing attachment; recovery record saved"],
  ["zh-CN", "正在准备消息，恢复记录已保存", "正在准备附件，恢复记录已保存"],
] as const)("%s pending recovery describes text and attachments separately", (locale, message, attachment) => {
  initLocale(locale);
  for (const hasAttachment of [false, true]) {
    const model = { task: { interrupt: vi.fn(), getSnapshot: () => ({ threadId: "synthetic" }) }, retainedOutbox: { rows: [], error: null },
      snapshot: { connected: true, running: false }, input: "newer draft", attachments: [], canSend: false,
      failedSubmissions: [{ id: "pending", content: "1+1=", createdAt: 1,
        attachments: hasAttachment ? [{ path: "/synthetic.txt", filename: "synthetic.txt", fileSize: 12, mimeType: "text/plain" }] : [],
        outcome: "failed", retrying: true, phase: "retaining" }] };
    const html = renderToStaticMarkup(<TaskComposer model={model as never} />);
    expect(html).toContain(hasAttachment ? attachment : message);
    expect(html).not.toContain(hasAttachment ? message : attachment);
    expect(html).toContain('data-testid="failed-submission-content"');
    expect(html).not.toContain('data-testid="submission-recovery-overlay"');
    expect(html).toContain("1+1=");
    expect(html).toContain("newer draft");
    expect(html).not.toContain('data-testid="failed-submission-error"');
  }
});

test.each(["en", "zh-CN"] as const)("%s V3 keeps normal submission phases out of the composer layout", locale => {
  initLocale(locale);
  interfaceState.version = "v3";
  try {
    for (const phase of ["preparing", "retaining", "sending"]) {
      const submission = { id: "pending", content: "original submission", createdAt: 1, attachments: [],
        outcome: phase === "sending" ? "unknown" : "failed", retrying: true, phase };
      const model = { task: { interrupt: vi.fn() }, retainedOutbox: { rows: [], error: null },
        snapshot: { threadId: "thread-1", connected: true, running: false }, input: "newer draft", attachments: [], canSend: false,
        failedSubmissions: [submission] };
      const html = renderToStaticMarkup(<TaskComposer model={model as never} />);
      expect(html).not.toContain('data-testid="failed-submissions"');
      expect(html).not.toContain('data-testid="submission-recovery-title"');
      expect(html).not.toContain('data-testid="submission-recovery-overlay"');
      expect(html).toContain("newer draft");
      expect(html).toContain('data-testid="message-input"');
    }
  } finally { interfaceState.version = "modern"; }
});

test.each([
  ["failed", false, undefined, "retry-failed-submission"],
  ["unknown", false, undefined, "verify-failed-submission"],
  ["unknown", true, { threadId: "thread-1", turnId: "turn-1" }, "verify-failed-submission"],
] as const)("V3 retains actionable %s submission recovery (checking=%s)", (outcome, retrying, acceptedTurn, action) => {
  initLocale("en");
  interfaceState.version = "v3";
  try {
    const model = { task: { interrupt: vi.fn() }, retainedOutbox: { rows: [], error: null },
      snapshot: { threadId: "thread-1", connected: true, running: false }, input: "newer draft", attachments: [], canSend: false,
      failedSubmissions: [{ id: "recovery", content: "original", createdAt: 1, attachments: [], outcome, retrying, acceptedTurn }] };
    const html = renderToStaticMarkup(<TaskComposer model={model as never} />);
    expect(html).toContain('data-testid="failed-submission"');
    expect(html).toContain('data-testid="submission-recovery-overlay"');
    expect(html).toContain(`data-testid="${action}"`);
    expect(html).toContain("newer draft");
  } finally { interfaceState.version = "modern"; }
});

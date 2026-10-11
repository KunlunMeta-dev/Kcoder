import React from "react";
import { createRequire } from "node:module";
import { expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { TaskComposer } from "./TaskComposer";
import { WorkspaceTabSwitcher } from "@/components/workspace-tab-switcher";
import { ChangesPanel } from "@/components/changes-panel";
import { FailureContinuation } from "@/components/failure-continuation";
import { TaskHeader } from "./TaskHeader";
import { RuntimeErrorBanner } from "./RuntimeErrorBanner";
import { ApprovalCard, QuestionCard } from "@/components/interaction-cards";
vi.hoisted(() => { Object.defineProperty(globalThis, "__DEV__", { value: false, configurable: true }); });
const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };
// Native attachment IO is outside this SSR accessibility test.
vi.mock("expo-file-system", () => ({ File: class File {} }));
vi.mock("expo-file-system/legacy", () => ({ cacheDirectory: "/fixture", EncodingType: { Base64: "base64" }, deleteAsync: vi.fn(), writeAsStringAsync: vi.fn() }));
vi.mock("expo-sharing", () => ({ shareAsync: vi.fn(), isAvailableAsync: vi.fn(async () => false) }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ArrowUp",
      "Paperclip",
      "Square",
      "ChevronLeft",
      "FileCode2",
      "MoreHorizontal",
      "PanelLeft",
      "ShieldCheck",
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
    "KCoder is working",
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
    "KCoder 正在工作",
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
      setInput: vi.fn(),
      setQueueError: vi.fn(),
      setComposerNotice: vi.fn(),
      openAttachmentSheet: vi.fn(),
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
            requestId: "approval",
            reason: "server reason",
            action: { toolName: "Bash", input: { command: "pwd" } },
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
            requestId: "question",
            questions: [
              {
                id: "q",
                header: "server header",
                prompt: "server prompt",
                options: [],
                allowsFreeform: true,
              },
            ],
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
        message={{ id: "failed", error: "raw server detail" } as never}
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

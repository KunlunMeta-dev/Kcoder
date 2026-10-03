import {
  isMobileSlashCommandInput,
  parseMobileGoalSlashAction,
  parseMobileSlashCommand,
  type MobileSlashCommand,
} from "@/components/composer-slash";
import { requestConfirmation } from "@/platform/confirmation";
import {
  goalHistoryNotice,
  goalIsUnfinished,
  goalLabel,
  goalStatusNotice,
} from "./taskLabels";
import type { useTaskAgentState } from "./useTaskAgentState";

export function useTaskCommands(context: ReturnType<typeof useTaskAgentState>) {
  const {
    openModelPicker,
    task,
    onDraftChange,
    snapshot,
    messageQueue,
    setInput,
    messageInputRef,
    goalEditExpectationRef,
    attachments,
    setQueueError,
    setComposerNotice,
  } = context;
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
    if (
      command.acceptsArguments &&
      !args &&
      !isGoalCommand &&
      command.name !== "/moa"
    ) {
      setQueueError(`用法：${command.name} <内容>`);
      return true;
    }
    if (!command.acceptsArguments && args) {
      setQueueError(`用法：${command.name}`);
      return true;
    }
    try {
      if (command.name === "/moa" || command.name === "/moa-plan") {
        if (!args) {
          const modes = await task.request<{ moaSummary: string }>(
            "session/modes",
            { threadId: snapshot.threadId },
          );
          setComposerNotice(modes.moaSummary);
        } else if (snapshot.running || snapshot.interaction) {
          messageQueue.enqueue({
            id: `mode-${Date.now()}`,
            content: `${command.name} ${args}`,
            attachments: [],
            createdAt: Date.now(),
          });
        } else {
          await task.send(
            args,
            [],
            command.name === "/moa" ? "moa" : "moa-plan",
          );
        }
        setInput("");
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
  return { ...context, executeSlashCommand, selectSlashCommand };
}

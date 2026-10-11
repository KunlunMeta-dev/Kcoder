import { t } from "@/i18n";
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
    inputIntentRef,
    snapshot,
    messageQueue,
    setInput,
    messageInputRef,
    goalEditExpectationRef,
    attachments,
    setQueueError,
    setComposerNotice,
  } = context;
  const persistDraftClear = () => {
    try {
      const operation = onDraftChange?.(undefined);
      if (operation) void operation.catch(() => {});
    } catch {
      // The input has already been cleared; the normal draft effect retries persistence.
    }
  };
  const clearInputIfOwned = (intent: {
    revision: number;
    cleared: boolean;
  }): boolean => {
    if (inputIntentRef.current.revision !== intent.revision) return false;
    if (!intent.cleared) {
      if (inputIntentRef.current.value !== "") setInput("");
      intent.revision = inputIntentRef.current.revision;
      intent.cleared = true;
      persistDraftClear();
    }
    return true;
  };
  const replaceInputIfOwned = (
    intent: { revision: number; cleared: boolean },
    value: string,
  ): boolean => {
    if (inputIntentRef.current.revision !== intent.revision) return false;
    setInput(value);
    intent.revision = inputIntentRef.current.revision;
    intent.cleared = false;
    return true;
  };
  const executeSlashCommand = async (rawValue: string): Promise<boolean> => {
    const parsed = parseMobileSlashCommand(rawValue);
    if (!parsed) {
      if (!isMobileSlashCommandInput(rawValue)) return false;
      const command = rawValue.trim().split(/\s+/, 1)[0];
      setQueueError(
        command === "/"
          ? t("task.enter_a_slash_command_name")
          : t("task.unknown_slash_command", { p0: command }),
      );
      return true;
    }
    if (attachments.length > 0) {
      setQueueError(t("task.slash_commands_cannot_include_attachments"));
      return true;
    }
    setQueueError(null);
    setComposerNotice(null);
    const inputIntent = {
      revision: inputIntentRef.current.revision,
      cleared: false,
    };
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
      setQueueError(t("task.usage_content", { p0: command.name }));
      return true;
    }
    if (!command.acceptsArguments && args) {
      setQueueError(t("task.usage", { p0: command.name }));
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
        clearInputIfOwned(inputIntent);
        return true;
      }
      if (command.name === "/model") {
        clearInputIfOwned(inputIntent);
        openModelPicker();
        return true;
      }
      if (command.name === "/compact") {
        const result = await task.compact();
        clearInputIfOwned(inputIntent);
        setComposerNotice(
          result.compacted
            ? t("task.context_compacted_tokens", {
                p0: result.preTokens,
                p1: result.postTokens,
              })
            : t("task.the_current_context_does_not_need_compaction"),
        );
        return true;
      }
      if (command.name === "/rename") {
        await task.rename(args);
        clearInputIfOwned(inputIntent);
        setComposerNotice(t("task.task_title_updated"));
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
          if (!current) throw new Error(t("task.no_current_goal"));
          if (current.status === "active") {
            setComposerNotice(goalStatusNotice(current));
            clearInputIfOwned(inputIntent);
            return true;
          }
          if (current.status !== "paused" && current.status !== "blocked") {
            throw new Error(
              t("task.a_goal_with_status_cannot_be_resumed_clear", {
                p0: current.status,
              }),
            );
          }
        }
        const goal = await task.updateGoalStatus(
          action.kind === "pause" ? "paused" : "active",
        );
        setComposerNotice(goalStatusNotice(goal));
      } else if (action.kind === "clear") {
        setComposerNotice(
          (await task.clearGoal())
            ? t("task.cleared", { p0: command.name })
            : t("task.no_current_goal"),
        );
      } else if (action.kind === "edit") {
        if (!action.objective) {
          const goal = await task.getGoal();
          if (!goal) throw new Error(t("task.no_current_goal"));
          if (
            !replaceInputIfOwned(
              inputIntent,
              `${command.name} edit ${goal.objective}`,
            )
          )
            return true;
          goalEditExpectationRef.current = {
            command: command.name,
            goalId: goal.goalId,
            revision: goal.revision,
          };
          setComposerNotice(t("task.the_goal_is_in_the_composer_edit_and"));
          requestAnimationFrame(() => messageInputRef.current?.focus());
          return true;
        }
        const capturedExpectation = goalEditExpectationRef.current;
        const expectation =
          capturedExpectation?.command === command.name
            ? capturedExpectation
            : undefined;
        const goal = await task.editGoal(
          action.objective,
          action.tokenBudget,
          expectation,
        );
        if (goalEditExpectationRef.current === capturedExpectation)
          goalEditExpectationRef.current = null;
        clearInputIfOwned(inputIntent);
        setComposerNotice(
          t("task.goal_updated_and_paused", { p0: goalLabel(goal) }),
        );
      } else if (action.kind === "create") {
        const existing = await task.getGoal();
        const startGoal = async () => {
          await task.setGoal(action.objective, mode, {
            tokenBudget: action.tokenBudget,
            verificationKind: action.verificationKind,
            expectedGoal: existing ?? undefined,
            requireNoGoal: !existing,
          });
          clearInputIfOwned(inputIntent);
          await task.send(action.objective);
          setComposerNotice(t("task.goal_command_started", { p0: command.name }));
        };
        if (existing && goalIsUnfinished(existing)) {
          requestConfirmation({
            title: t("task.replace_the_current", { p0: goalLabel(existing) }),
            message: t(
              "task.the_current_goal_is_unfinished_confirm_to_replace",
            ),
            confirmLabel: t("task.replace_goal"),
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
      if (action.kind !== "edit") clearInputIfOwned(inputIntent);
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

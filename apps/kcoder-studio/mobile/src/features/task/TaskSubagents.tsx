import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { QuestionCard } from "@/components/interaction-cards";
import {
  spacing,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type {
  AgentSummary,
  QuestionInteraction,
} from "@/runtime/task-runtime/types";
import type { AgentCommands, AgentPage } from "@/runtime/task-runtime/agents";
import {
  clearAgentIntent,
  readAgentIntent,
  saveAgentIntent,
  type MobileAgentIntent,
} from "./mobileAgentIntent";

const viewIds = new WeakMap<TaskRuntime, number>();
let nextViewId = 0;
export function taskSubagentViewKey(task: TaskRuntime): number {
  let id = viewIds.get(task);
  if (id === undefined) {
    id = ++nextViewId;
    viewIds.set(task, id);
  }
  return id;
}

/** A native overlay leaves the parent composer mounted and uses the same resident connection. */
export function TaskSubagents({
  task,
  bottomInset,
}: {
  task: TaskRuntime;
  bottomInset: number;
}) {
  useLocale();
  const { colors, styles } = useThemedStyles(createTaskSubagentAppearance);
  const [open, setOpen] = useState(false),
    [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, select] = useState<string | null>(null),
    [page, setPage] = useState<AgentPage | null>(null);
  const [commands, setCommands] = useState<AgentCommands | null>(null),
    [intent, setIntent] = useState<MobileAgentIntent | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [expanded, expand] = useState(false),
    [history, setHistory] = useState(false);
  const [failure, setFailure] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    flight = useRef<number | null>(null),
    actionEpoch = useRef(0);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const agent = agents.find((row) => row.agentId === selected);
  const profile = task.reconnectContext;
  const scope = agent
    ? `${profile?.profile.id ?? ""}\0${profile?.server.id ?? ""}\0${task.snapshot.threadId}\0${agent.agentId}\0${agent.presentation?.journalScope ?? ""}`
    : "";
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const capabilities = task.agentCapabilities();
  const questions = task.pendingInteractions.filter(
    (row): row is QuestionInteraction =>
      row.kind === "question" &&
      row.sourceAgent?.agentId === selected &&
      row.sourceAgent.parentSessionId === task.snapshot.threadId,
  );
  const refresh = useCallback(async () => {
    if (!open || flight.current === generation.current) return;
    const current = generation.current;
    flight.current = current;
    try {
      const result = await task.listSubagents();
      if (current !== generation.current) return;
      setAgents(result.agents);
      const value = result.agents.find((row) => row.agentId === selected);
      if (value && !history) {
        const content = await task.readSubagent(value);
        if (current !== generation.current) return;
        if (!content.unchanged) setPage(content);
      }
      if (value && task.agentCapabilities().commands) {
        const rows = await task.readSubagentCommands(value.agentId);
        if (current !== generation.current) return;
        setCommands(rows);
      }
      setFailure(null);
    } catch (error) {
      if (current === generation.current)
        setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (flight.current === current) flight.current = null;
    }
  }, [task, open, selected, history]);
  useEffect(() => {
    generation.current++;
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      generation.current++;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    actionEpoch.current++;
    setReadyScope(null);
    const timer = setTimeout(() => {
      setIntent(null);
      setCommands(null);
      setNotice(null);
      setBusy(false);
      setFailure(null);
      void readAgentIntent(scope)
        .then((value) => {
          if (currentScope.current !== scope) return;
          setIntent(value);
          setReadyScope(scope);
        })
        .catch((error) => {
          if (currentScope.current === scope) setFailure(String(error));
        });
    }, 0);
    return () => clearTimeout(timer);
  }, [scope]);
  const choose = (id: string) => {
    select(id);
    setPage(null);
    setCommands(null);
    setHistory(false);
    expand(false);
    setFailure(null);
  };
  const checkIntent = async () => {
    if (!agent || !intent || busy) return;
    const captured = scope,
      epoch = actionEpoch.current;
    setBusy(true);
    try {
      const result = await task.readSubagentCommand(
        agent.agentId,
        intent.clientMessageId,
      );
      if (currentScope.current !== captured || actionEpoch.current !== epoch)
        return;
      if (result.receipt) {
        await clearAgentIntent(captured);
        if (currentScope.current !== captured || actionEpoch.current !== epoch)
          return;
        setIntent(null);
        setNotice(
          t("task.target_receipt_applied_does_not_mean_the_task", {
            p0: result.receipt.status,
          }),
        );
      } else setNotice(t("task.the_target_has_no_receipt_yet_this_does"));
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setFailure(String(error));
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setBusy(false);
    }
  };
  const send = async () => {
    const message = drafts[scope]?.trim();
    if (
      !agent ||
      !message ||
      busy ||
      intent ||
      !commands ||
      readyScope !== scope
    )
      return;
    const captured = scope,
      epoch = actionEpoch.current,
      next = {
        clientMessageId: `cmd:${commands.receiptEpoch}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: Date.now(),
      };
    setBusy(true);
    setFailure(null);
    try {
      await saveAgentIntent(captured, next);
      if (currentScope.current !== captured || actionEpoch.current !== epoch)
        return;
      setIntent(next);
      const result = await task.steerSubagent(
        agent.agentId,
        message,
        next.clientMessageId,
      );
      if (currentScope.current !== captured || actionEpoch.current !== epoch)
        return;
      await clearAgentIntent(captured);
      if (currentScope.current !== captured || actionEpoch.current !== epoch)
        return;
      setIntent(null);
      setNotice(
        t("task.instruction_status_applied_does_not_mean_the_task", {
          p0: result.status,
        }),
      );
      if (result.status !== "rejected")
        setDrafts((values) => ({ ...values, [captured]: "" }));
      await refresh();
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setFailure(
          t("task.the_result_may_be_unknown_check_the_original", {
            p0: error instanceof Error ? error.message : String(error),
          }),
        );
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setBusy(false);
    }
  };
  const loadHistory = async (offset = 0, revision?: string) => {
    if (!agent || busy) return;
    const captured = scope,
      epoch = actionEpoch.current;
    setBusy(true);
    try {
      const result = await task.readSubagent(agent, {
        history: true,
        offset,
        revision,
      });
      if (currentScope.current === captured && actionEpoch.current === epoch) {
        setHistory(true);
        setPage(result);
        expand(true);
        setFailure(null);
      }
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setFailure(String(error));
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch)
        setBusy(false);
    }
  };
  return (
    <>
      {capabilities.discover ? (
        <Button
          testID="mobile-subagents-open"
          variant="ghost"
          onPress={() => setOpen(true)}
        >
          {t("task.view_subagents")}
        </Button>
      ) : null}
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
          <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
          >
            <View style={styles.header}>
              <Button
                variant="ghost"
                onPress={() => (selected ? select(null) : setOpen(false))}
              >
                {t("task.back")}
              </Button>
              <Text style={styles.title}>{t("task.subagents")}</Text>
              <Button
                variant="ghost"
                disabled={busy}
                onPress={() => void refresh()}
              >
                {t("task.refresh")}
              </Button>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                padding: spacing.md,
                paddingBottom: Math.max(bottomInset, spacing.md),
              }}
            >
              {failure ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {failure}
                </Text>
              ) : null}
              {!selected ? (
                <View>
                  {agents.length ? (
                    agents.map((row) => (
                      <View key={row.agentId} style={styles.row}>
                        <Button
                          testID={`mobile-subagent-${row.agentId}`}
                          onPress={() => choose(row.agentId)}
                        >
                          {row.agentName ||
                            row.presentation?.goal ||
                            row.agentId}
                        </Button>
                        <Text style={styles.secondary}>{row.status}</Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.secondary}>
                      {t("task.no_subagents_to_display")}
                    </Text>
                  )}
                </View>
              ) : agent ? (
                <>
                  <Text style={styles.title}>
                    {agent.agentName ||
                      agent.presentation?.goal ||
                      agent.agentId}
                  </Text>
                  <Text style={styles.secondary}>
                    {agent.status} ·{" "}
                    {agent.presentation?.role || t("task.agent")}
                  </Text>
                  {agent.presentation?.goal ? (
                    <Text style={styles.text}>{agent.presentation.goal}</Text>
                  ) : null}
                  <View style={styles.actions}>
                    <Button onPress={() => expand((value) => !value)}>
                      {expanded
                        ? t("task.collapse_transcript")
                        : t("task.expand_transcript")}
                    </Button>
                    {capabilities.pages ? (
                      <Button
                        disabled={busy}
                        onPress={() => void loadHistory()}
                      >
                        {t("task.history")}
                      </Button>
                    ) : null}
                    {history ? (
                      <Button onPress={() => setHistory(false)}>
                        {t("task.live")}
                      </Button>
                    ) : null}
                  </View>
                  {expanded ? (
                    <Text selectable style={styles.output}>
                      {page?.content || t("task.no_public_transcript")}
                    </Text>
                  ) : null}
                  {history && page?.nextOffset != null ? (
                    <Button
                      disabled={busy}
                      onPress={() =>
                        void loadHistory(
                          page.nextOffset,
                          typeof page.revision === "string"
                            ? page.revision
                            : undefined,
                        )
                      }
                    >
                      {t("task.next_page")}
                    </Button>
                  ) : null}
                  {questions.map((question) => (
                    <QuestionCard
                      key={question.requestId}
                      interaction={question}
                      onSubmit={(answers) =>
                        task.respondAgentQuestions(
                          agent.agentId,
                          question.requestId,
                          answers,
                        )
                      }
                      onCancel={() =>
                        task.respondAgentQuestions(
                          agent.agentId,
                          question.requestId,
                          {},
                          true,
                        )
                      }
                    />
                  ))}
                  {capabilities.commands ? (
                    <>
                      <TextInput
                        testID="mobile-subagent-draft"
                        accessibilityLabel={t("task.add_instruction")}
                        multiline
                        value={drafts[scope] ?? ""}
                        editable={!busy && !intent}
                        onChangeText={(text) =>
                          setDrafts((values) => ({ ...values, [scope]: text }))
                        }
                        placeholder={t(
                          "task.add_an_instruction_to_apply_at_a_safe",
                        )}
                        placeholderTextColor={colors.textMuted}
                        style={styles.input}
                      />
                      {intent ? (
                        <Button
                          testID="mobile-subagent-query"
                          disabled={busy}
                          onPress={() => void checkIntent()}
                        >
                          {t("task.check_original_instruction_status")}
                        </Button>
                      ) : (
                        <Button
                          testID="mobile-subagent-send"
                          disabled={
                            busy ||
                            readyScope !== scope ||
                            !commands ||
                            !agent.acceptingMessages ||
                            !drafts[scope]?.trim()
                          }
                          onPress={() => void send()}
                        >
                          {t("task.send_instruction")}
                        </Button>
                      )}
                    </>
                  ) : (
                    <Text style={styles.secondary}>
                      {t(
                        "task.this_target_only_supports_viewing_transcripts_update_the",
                      )}
                    </Text>
                  )}
                  {notice ? (
                    <Text style={styles.secondary}>{notice}</Text>
                  ) : null}
                  {commands?.receipts.map((row) => (
                    <Text key={row.clientMessageId} style={styles.secondary}>
                      {row.status} · {row.clientMessageId}
                    </Text>
                  ))}
                  {capabilities.stop &&
                  agent.presentation?.canStop &&
                  agent.backgroundRun ? (
                    <Button
                      testID="mobile-subagent-stop"
                      disabled={busy}
                      variant="danger"
                      onPress={() => {
                        const captured = scope,
                          epoch = actionEpoch.current;
                        setBusy(true);
                        void task
                          .stopSubagent(agent)
                          .then((result) => {
                            if (
                              currentScope.current !== captured ||
                              actionEpoch.current !== epoch
                            )
                              return;
                            setNotice(
                              t("task.stop_status", { p0: result.status }),
                            );
                            return refresh();
                          })
                          .catch((error) => {
                            if (
                              currentScope.current === captured &&
                              actionEpoch.current === epoch
                            )
                              setFailure(String(error));
                          })
                          .finally(() => {
                            if (
                              currentScope.current === captured &&
                              actionEpoch.current === epoch
                            )
                              setBusy(false);
                          });
                      }}
                    >
                      {t("task.stop_this_agent")}
                    </Button>
                  ) : null}
                </>
              ) : (
                <ActivityIndicator color={colors.textMuted} />
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
const createTaskSubagentAppearance = (colors: ThemeColors) => ({
  colors,
  styles: StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      minHeight: 56,
      paddingTop: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { color: colors.text, fontSize: 18, fontWeight: "500" },
    text: { color: colors.text, fontSize: 14, marginVertical: 8 },
    secondary: { color: colors.textMuted, fontSize: 13, marginVertical: 6 },
    row: {
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: 8,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginVertical: 12,
    },
    input: {
      minHeight: 72,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 12,
      marginVertical: 12,
    },
    output: { color: colors.text, fontSize: 13, lineHeight: 20 },
    error: { color: colors.red, marginVertical: 12 },
  }),
});

import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useInterfaceVersion } from "@/storage/interface-version";
import { TaskSubagentPanel, TaskSubagentList, subagentStatusLabel } from "./TaskSubagentView";
import { TaskSubagentConversation } from "./TaskSubagentConversation";
import { useSubagentConversation } from "./useSubagentConversation";
import { subagentMessageAction, subagentMessageDisposition } from "./subagent-message-policy";
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
import { interactionCardIdentity, QuestionCard } from "@/components/interaction-cards";
import {
  spacing,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import { selectorForInteraction, matchesInteractionSelector } from "@/runtime/task-runtime/interactions";
import { interactionServerIdentity } from "@/runtime/task-runtime/threadDirectory";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { useApp } from "@/state/AppContext";
import {
  sourceAgentQuestionRouteRow,
  sourceAgentQuestionSelection,
  type SourceAgentQuestionRouteFocus,
} from "@/features/interaction-inbox/locator";
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
  focusQuestion = null,
  sourceAgentRouteFocus = null,
  openRequest,
  hideTrigger = false,
}: {
  task: TaskRuntime;
  bottomInset: number;
  focusQuestion?: QuestionInteraction | null;
  sourceAgentRouteFocus?: SourceAgentQuestionRouteFocus | null;
  openRequest?: object;
  hideTrigger?: boolean;
}) {
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { colors, styles } = useThemedStyles(createTaskSubagentAppearance);
  const {
    activeProfile,
    runtime: appRuntime,
    demo,
    runtimeActivationEpoch,
    isCurrentInteractionOwner,
  } = useApp();
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
  const autoOpenedRef = useRef(false);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [agentListOwnerKey, setAgentListOwnerKey] = useState<string | null>(null);
  const agent = agents.find((row) => row.agentId === selected);
  const profile = task.reconnectContext;
  const authorizedServer = profile
    ? appRuntime.servers.find((row) => row.id === profile.server.id)
    : undefined;
  const targetIdentity = authorizedServer ? interactionServerIdentity(authorizedServer) : "";
  const activeAuthorizationScope = activeProfile ? profileAuthorizationScopeKey(activeProfile) : "";
  const ownerKey = JSON.stringify([
    task.snapshot.threadId,
    activeProfile?.id ?? "",
    activeAuthorizationScope,
    profile?.profile.id ?? "",
    profile ? profileAuthorizationScopeKey(profile.profile) : "",
    profile?.server.id ?? "",
    targetIdentity,
    task.runtimeInstanceNonce,
    runtimeActivationEpoch,
    task.clientGeneration,
  ]);
  const navigationOwner = JSON.stringify([task.snapshot.threadId, activeProfile?.id, activeAuthorizationScope,
    profile?.profile.id, profile ? profileAuthorizationScopeKey(profile.profile) : "", profile?.server.id,
    targetIdentity, task.runtimeInstanceNonce, runtimeActivationEpoch]);
  const previousNavigationOwner = useRef(navigationOwner);
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const scopeGateRef = useRef<() => boolean>(() => false);
  scopeGateRef.current = () => {
    const context = task.reconnectContext;
    const server = context
      ? appRuntime.servers.find((row) => row.id === context.server.id)
      : undefined;
    if (!context || !activeProfile || !server || demo || appRuntime.reauthorizationRequired ||
        !appRuntime.serversReady || activeProfile.id !== context.profile.id ||
        profileAuthorizationScopeKey(activeProfile) !== profileAuthorizationScopeKey(context.profile) ||
        activeProfile.accessToken !== context.profile.accessToken ||
        activeProfile.refreshToken !== context.profile.refreshToken ||
        interactionServerIdentity(server) !== interactionServerIdentity(context.server) ||
        context.profileActivationEpoch !== runtimeActivationEpoch)
      return false;
    return isCurrentInteractionOwner({
      profileId: activeProfile.id,
      profileAuthorizationScopeKey: profileAuthorizationScopeKey(activeProfile),
      serverId: server.id,
      serverConfigIdentity: interactionServerIdentity(server),
      profileActivationEpoch: runtimeActivationEpoch,
    });
  };
  const ownerGateRef = useRef<() => boolean>(() => false);
  ownerGateRef.current = () => {
    const context = task.reconnectContext;
    const server = context
      ? appRuntime.servers.find((row) => row.id === context.server.id)
      : undefined;
    return Boolean(scopeGateRef.current() && context && server && !task.isDisposed() &&
      !task.reconnecting && task.getSnapshot().connected && task.client?.isTransportOpen() &&
      taskRuntimeRegistry.entries().some((entry) => entry.profileId === context.profile.id &&
        entry.serverId === server.id && entry.threadId === task.snapshot.threadId && entry.runtime === task));
  };
  const scope = agent
    ? JSON.stringify([ownerKey, agent.agentId, agent.presentation?.journalScope ?? ""])
    : "";
  // Drafts survive transport replacement, but never cross an account, target, parent or worker journal.
  const draftScope = agent ? JSON.stringify([activeProfile?.id, activeAuthorizationScope, profile?.server.id,
    targetIdentity, task.snapshot.threadId, agent.agentId, agent.presentation?.journalScope ?? ""]) : "";
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const intentOwnerScope = useRef(draftScope), intentLookupScope = useRef(scope), latestIntent = useRef(intent);
  latestIntent.current = intent;

  const capabilities = task.agentCapabilities();
  const handledOpenRequest = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest || !capabilities.discover) return;
    handledOpenRequest.current = openRequest;
    setOpen(true);
  }, [openRequest, capabilities.discover]);
  const questions = task.pendingInteractions.filter(
    (row): row is QuestionInteraction =>
      row.kind === "question" &&
      row.sourceAgent?.agentId === selected &&
      row.sourceAgent.parentSessionId === task.snapshot.threadId,
  );
  const focusQuestionKey = focusQuestion ? interactionCardIdentity(focusQuestion) : "";
  const sourceAgentRouteFocusKey = sourceAgentRouteFocus
    ? JSON.stringify([
      sourceAgentRouteFocus.kind,
      sourceAgentRouteFocus.requestId,
      sourceAgentRouteFocus.interactionId,
      sourceAgentRouteFocus.turnId,
      sourceAgentRouteFocus.appServerEpoch,
      sourceAgentRouteFocus.agentId,
      sourceAgentRouteFocus.parentSessionId,
      sourceAgentRouteFocus.status,
      sourceAgentRouteFocus.liveActionable,
    ])
    : "";
  const ownerToken = () => ({
    key: ownerKey,
    runtime: task,
    client: task.client,
    generation: task.clientGeneration,
    runtimeNonce: task.runtimeInstanceNonce,
  });
  const ownerTokenCurrent = (captured: ReturnType<typeof ownerToken>) =>
    captured.key === ownerKeyRef.current && captured.runtime === task &&
    captured.client === task.client && captured.generation === task.clientGeneration &&
    captured.runtimeNonce === task.runtimeInstanceNonce && ownerGateRef.current();
  const canAnswerQuestion = (question: QuestionInteraction) => {
    const selector = selectorForInteraction(question);
    return Boolean(agent && agent.agentId === question.sourceAgent?.agentId &&
      question.sourceAgent?.parentSessionId === task.snapshot.threadId &&
      task.pendingInteractions.some((candidate) => matchesInteractionSelector(candidate, selector)) &&
      isCurrentInteractionOwner(question.owner) && ownerGateRef.current() &&
      task.isInteractionActionable(question));
  };
  const ownerAuthorized = scopeGateRef.current();
  const currentSocketOwner = ownerGateRef.current();
  const [streamRefresh, setStreamRefresh] = useState<object>();
  const conversation = useSubagentConversation(task, agent?.agentId, draftScope,
    Boolean(v3 && open && !history && agent && capabilities.conversation && currentSocketOwner),
    () => ownerGateRef.current(), typeof agent?.backgroundRun?.runId === "string" ? agent.backgroundRun.runId : undefined, streamRefresh);
  const conversationWritable = !v3 || Boolean(capabilities.conversation && conversation?.snapshot.connected && !conversation.loading && !conversation.error && currentSocketOwner);

  const refresh = useCallback(async () => {
    if (!open || flight.current === generation.current || !ownerGateRef.current()) return;
    const current = generation.current;
    const capturedOwner = ownerToken();
    flight.current = current;
    try {
      const result = await task.listSubagents();
      if (current !== generation.current || !ownerTokenCurrent(capturedOwner)) return;
      setAgents(result.agents);
      setAgentListOwnerKey(ownerKey);
      const value = result.agents.find((row) => row.agentId === selected);
      if (focusQuestion?.sourceAgent?.agentId === selected && !value)
        setNotice(t("inbox.subagent_not_found"));
      else if (focusQuestion?.sourceAgent?.agentId === selected && value)
        setNotice(null);
      if (value && !history && !(v3 && capabilities.conversation)) {
        const content = await task.readSubagent(value);
        if (current !== generation.current || !ownerTokenCurrent(capturedOwner)) return;
        if (!content.unchanged) setPage(content);
      }
      if (value && task.agentCapabilities().commands) {
        const rows = await task.readSubagentCommands(value.agentId);
        if (current !== generation.current || !ownerTokenCurrent(capturedOwner)) return;
        setCommands(rows);
      }
      setFailure(null);
    } catch (error) {
      if (current === generation.current && ownerTokenCurrent(capturedOwner))
        setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (flight.current === current) flight.current = null;
    }
  }, [task, open, selected, history, ownerKey, focusQuestionKey, v3, capabilities.conversation]);
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
    const changedOwner = previousNavigationOwner.current !== navigationOwner;
    previousNavigationOwner.current = navigationOwner;
    setCommands(null);
    setReadyScope(null);
    setAgentListOwnerKey(null);
    setFailure(null);
    setNotice(null);
    setBusy(false);
    if (changedOwner) {
      setAgents([]);
      setPage(null);
      setOpen(false);
      select(null);
      autoOpenedRef.current = false;
    }
  }, [ownerKey, navigationOwner]);
  useEffect(() => {
    const liveAgentId = focusQuestion
      ? sourceAgentQuestionSelection(focusQuestion, task.snapshot.threadId, task.pendingInteractions)
      : null;
    const liveTarget = Boolean(liveAgentId && focusQuestion && ownerGateRef.current() &&
      task.isInteractionActionable(focusQuestion));
    const scopedRows = activeAuthorizationScope
      ? taskRuntimeRegistry.interactionInboxRows(activeAuthorizationScope)
      : [];
    const routeRow = sourceAgentQuestionRouteRow(
      sourceAgentRouteFocus,
      scopedRows,
      task.snapshot.threadId,
    );
    const routeTarget = Boolean(routeRow && activeProfile && profile && authorizedServer &&
      routeRow.profileId === activeProfile.id &&
      routeRow.profileAuthorizationScopeKey === activeAuthorizationScope &&
      routeRow.serverId === profile.server.id &&
      routeRow.serverConfigIdentity === targetIdentity &&
      routeRow.threadId === task.snapshot.threadId && scopeGateRef.current());
    const agentId = liveTarget ? liveAgentId : routeTarget ? routeRow?.sourceAgent?.agentId : null;
    if (!agentId) {
      if (autoOpenedRef.current) {
        setOpen(false);
        select(null);
        autoOpenedRef.current = false;
      }
      return;
    }
    autoOpenedRef.current = true;
    setOpen(true);
    select(agentId);
    setPage(null);
    setCommands(null);
    setHistory(false);
    expand(false);
  }, [task, focusQuestionKey, sourceAgentRouteFocusKey, ownerKey,
    activeAuthorizationScope, activeProfile?.id, profile?.server.id,
    authorizedServer?.id, targetIdentity]);
  useEffect(() => {
    actionEpoch.current++;
    setReadyScope(null);
    if (!scope) return;
    const retainedIntent = intentOwnerScope.current === draftScope ? latestIntent.current : null;
    intentOwnerScope.current = draftScope;
    const timer = setTimeout(() => {
      setCommands(null);
      setNotice(null);
      setBusy(false);
      setFailure(null);
      if (retainedIntent) {
        setReadyScope(scope);
        return;
      }
      intentLookupScope.current = scope;
      setIntent(null);
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
  }, [scope, draftScope]);
  const choose = (id: string) => {
    select(id);
    setPage(null);
    setCommands(null);
    setHistory(false);
    expand(false);
    setFailure(null);
  };
  const checkIntent = async () => {
    if (!agent || !intent || busy || readyScope !== scope || !ownerGateRef.current()) return;
    const captured = scope,
      epoch = actionEpoch.current,
      capturedOwner = ownerToken();
    setBusy(true);
    try {
      const result = await task.readSubagentCommand(
        agent.agentId,
        intent.clientMessageId,
      );
      if (currentScope.current !== captured || actionEpoch.current !== epoch || !ownerTokenCurrent(capturedOwner))
        return;
      if (result.receipt) {
        await clearAgentIntent(intentLookupScope.current);
        if (currentScope.current !== captured || actionEpoch.current !== epoch || !ownerTokenCurrent(capturedOwner))
          return;
        setIntent(null);
        setNotice(
          t("task.target_receipt_applied_does_not_mean_the_task", {
            p0: result.receipt.status,
          }),
        );
      } else setNotice(t("task.the_target_has_no_receipt_yet_this_does"));
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setFailure(String(error));
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setBusy(false);
    }
  };
  const send = async () => {
    const message = drafts[draftScope]?.trim();
    if (
      !agent ||
      !subagentMessageAction(agent) ||
      !conversationWritable ||
      !message ||
      busy ||
      intent ||
      !commands ||
      readyScope !== scope ||
      !ownerGateRef.current()
    )
      return;
    if (new TextEncoder().encode(message).byteLength > 64 * 1024) {
      setFailure(t("task.subagent_message_too_large"));
      return;
    }
    const captured = scope,
      epoch = actionEpoch.current,
      capturedOwner = ownerToken(),
      next = {
        clientMessageId: `cmd:${commands.receiptEpoch}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: Date.now(),
      };
    setBusy(true);
    setFailure(null);
    try {
      await saveAgentIntent(captured, next);
      if (currentScope.current !== captured || actionEpoch.current !== epoch || !ownerTokenCurrent(capturedOwner))
        return;
      intentLookupScope.current = captured;
      setIntent(next);
      const result = await task.steerSubagent(
        agent.agentId,
        message,
        next.clientMessageId,
      );
      if (currentScope.current !== captured || actionEpoch.current !== epoch || !ownerTokenCurrent(capturedOwner))
        return;
      const disposition = subagentMessageDisposition(result);
      if (disposition === "unknown") {
        setNotice(t("task.the_result_may_be_unknown_check_the_original", { p0: result.status }));
        return;
      }
      await clearAgentIntent(captured);
      if (currentScope.current !== captured || actionEpoch.current !== epoch || !ownerTokenCurrent(capturedOwner))
        return;
      setIntent(null);
      setNotice(
        disposition === "accepted"
          ? t("task.instruction_status_applied_does_not_mean_the_task", { p0: result.status })
          : result.status === "finishing" ? t("task.subagent_finishing")
          : t("task.subagent_not_accepted", { p0: result.reasonCode || result.status }),
      );
      if (disposition === "accepted")
        setDrafts((values) => ({ ...values, [draftScope]: values[draftScope]?.trim() === message ? "" : values[draftScope] }));
      await refresh();
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setFailure(
          t("task.the_result_may_be_unknown_check_the_original", {
            p0: error instanceof Error ? error.message : String(error),
          }),
        );
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setBusy(false);
    }
  };
  const loadHistory = async (offset = 0, revision?: string) => {
    if (!agent || busy || !ownerGateRef.current()) return;
    const captured = scope,
      epoch = actionEpoch.current,
      capturedOwner = ownerToken();
    setBusy(true);
    try {
      const result = await task.readSubagent(agent, {
        history: true,
        offset,
        revision,
      });
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner)) {
        setHistory(true);
        setPage(result);
        expand(true);
        setFailure(null);
      }
    } catch (error) {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setFailure(String(error));
    } finally {
      if (currentScope.current === captured && actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner))
        setBusy(false);
    }
  };
  const answerAgentQuestion = async (
    question: QuestionInteraction,
    answers: Record<string, string[]>,
    ignored: boolean,
  ) => {
    if (!agent || busy || !canAnswerQuestion(question)) return;
    const selector = selectorForInteraction(question);
    const capturedOwner = ownerToken();
    setBusy(true);
    setFailure(null);
    try {
      const currentAgents = await task.listSubagents();
      if (!ownerTokenCurrent(capturedOwner)) return;
      const exact = task.pendingInteractions.find((candidate) =>
        matchesInteractionSelector(candidate, selector),
      );
      if (currentAgents.threadId !== task.snapshot.threadId ||
          !currentAgents.agents.some((candidate) => candidate.agentId === question.sourceAgent?.agentId) ||
          exact?.kind !== "question" || exact.sourceAgent?.parentSessionId !== task.snapshot.threadId ||
          exact.sourceAgent.agentId !== question.sourceAgent?.agentId ||
          !isCurrentInteractionOwner(exact.owner) || !ownerGateRef.current() ||
          !task.isInteractionActionable(exact)) {
        setNotice(t("inbox.subagent_not_found"));
        return;
      }
      task.respondAgentQuestions(
        exact.sourceAgent.agentId,
        exact.requestId,
        answers,
        ignored,
        selector,
      );
      setNotice(null);
    } catch (error) {
      if (ownerTokenCurrent(capturedOwner))
        setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (ownerTokenCurrent(capturedOwner)) setBusy(false);
    }
  };
  const stopAgent = () => {
    if (!agent || !ownerGateRef.current()) return;
    const captured = scope,
      epoch = actionEpoch.current,
      capturedOwner = ownerToken();
    setBusy(true);
    void task
      .stopSubagent(agent)
      .then((result) => {
        if (
          currentScope.current !== captured ||
          actionEpoch.current !== epoch ||
          !ownerTokenCurrent(capturedOwner)
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
          actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner)
        )
          setFailure(String(error));
      })
      .finally(() => {
        if (
          currentScope.current === captured &&
          actionEpoch.current === epoch && ownerTokenCurrent(capturedOwner)
        )
          setBusy(false);
      });
  };
  const actionableQuestions = questions.filter(canAnswerQuestion);
  const readonlyQuestionCount = questions.length - actionableQuestions.length;
  const content = <>
              {!ownerAuthorized ? (
                <Text accessibilityRole="alert" testID="subagent-owner-readonly" style={styles.secondary}>
                  {t("inbox.out_of_scope")}
                </Text>
              ) : null}
              {ownerAuthorized && failure ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {failure}
                </Text>
              ) : null}
              {ownerAuthorized && !currentSocketOwner && questions.length === 0 ? (
                <Text accessibilityRole="alert" testID="subagent-offline-readonly" style={styles.secondary}>
                  {t("inbox.focused_readonly")}
                </Text>
              ) : null}
              {ownerAuthorized && selected && !agent && sourceAgentRouteFocus?.agentId === selected ? (
                <View testID="subagent-route-focus-readonly">
                  <Text style={styles.title}>{selected}</Text>
                  <Text style={styles.secondary}>
                    {t("inbox.subagent_parent", { p0: sourceAgentRouteFocus.parentSessionId })}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("inbox.target_workspace", {
                      p0: authorizedServer?.label ?? profile?.server.id ?? "—",
                      p1: task.snapshot.cwd,
                    })}
                  </Text>
                  <Text accessibilityRole="alert" style={styles.secondary}>
                    {sourceAgentRouteFocus.status === "unsupported"
                      ? t("inbox.status_unsupported")
                      : sourceAgentRouteFocus.status === "unknown"
                        ? t("inbox.status_unknown")
                        : !sourceAgentRouteFocus.liveActionable || !currentSocketOwner
                          ? t("inbox.original_connection_only")
                          : t("inbox.focused_readonly")}
                  </Text>
                  {notice ? <Text style={styles.secondary}>{notice}</Text> : null}
                </View>
              ) : null}
              {ownerAuthorized && !selected ? (
                v3 ? <TaskSubagentList agents={agents} onChoose={choose}
                  pendingCount={id => task.pendingInteractions.filter(row => row.kind === "question" && row.sourceAgent?.agentId === id && row.sourceAgent.parentSessionId === task.snapshot.threadId).length} /> : <View>
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
                        <Text style={styles.secondary}>
                          {subagentStatusLabel(row.status)} · {t("inbox.subagent_pending_count", {
                            p0: questions.filter((question) => question.sourceAgent?.agentId === row.agentId).length,
                          })}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.secondary}>
                      {t("task.no_subagents_to_display")}
                    </Text>
                  )}
                </View>
              ) : ownerAuthorized && agent ? (
                <>
                  {v3 ? null : <>
                  <Text style={styles.title}>
                    {agent.agentName ||
                      agent.presentation?.goal ||
                      agent.agentId}
                  </Text>
                  <Text style={styles.secondary}>
                    {subagentStatusLabel(agent.status)} ·{" "}
                    {agent.presentation?.role || t("task.agent")}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("inbox.subagent_parent", { p0: task.snapshot.threadId })}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("inbox.target_workspace", {
                      p0: authorizedServer?.label ?? profile?.server.id ?? "—",
                      p1: agent.presentation?.directory || task.snapshot.cwd,
                    })}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("inbox.subagent_pending_count", { p0: questions.length })}
                  </Text>
                  </>}
                  {sourceAgentRouteFocus?.agentId === selected &&
                    (sourceAgentRouteFocus.status !== "pending" ||
                      !sourceAgentRouteFocus.liveActionable || !currentSocketOwner) ? (
                    <Text accessibilityRole="alert" testID="subagent-route-focus-status" style={styles.secondary}>
                      {sourceAgentRouteFocus.status === "unsupported"
                        ? t("inbox.status_unsupported")
                        : sourceAgentRouteFocus.status === "unknown"
                          ? t("inbox.status_unknown")
                          : t("inbox.original_connection_only")}
                    </Text>
                  ) : null}
                  {!v3 && agent.presentation?.goal ? (
                    <Text style={styles.text}>{agent.presentation.goal}</Text>
                  ) : null}
                  <View style={styles.actions}>
                    {!v3 ? <Button onPress={() => expand((value) => !value)}>
                      {expanded
                        ? t("task.collapse_transcript")
                        : t("task.expand_transcript")}
                    </Button> : null}
                    {capabilities.pages && !(v3 && capabilities.conversation) ? (
                      <Button
                        disabled={busy}
                        onPress={() => void loadHistory()}
                      >
                        {t("task.history")}
                      </Button>
                    ) : null}
                    {history && !v3 ? (
                      <Button onPress={() => setHistory(false)}>
                        {t("task.live")}
                      </Button>
                    ) : null}
                  </View>
                  {!v3 && expanded ? (
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
                  {readonlyQuestionCount > 0 ? (
                    <Text testID="subagent-question-readonly" accessibilityRole="alert" style={styles.secondary}>
                      {t("inbox.focused_readonly")}
                    </Text>
                  ) : null}
                  {actionableQuestions.map((question) => (
                    <QuestionCard
                      key={interactionCardIdentity(question)}
                      interaction={question}
                      pendingCount={questions.length}
                      disabled={busy}
                      cancelLabel={t("task.ignore_question")}
                      onSubmit={(answers) =>
                        void answerAgentQuestion(question, answers, false)
                      }
                      onCancel={() =>
                        void answerAgentQuestion(question, {}, true)
                      }
                    />
                  ))}
                  {capabilities.commands && !v3 ? (
                    <>
                      <TextInput
                        testID="mobile-subagent-draft"
                        accessibilityLabel={t("task.add_instruction")}
                        multiline
                        value={drafts[draftScope] ?? ""}
                        editable={!busy && !intent}
                        onChangeText={(text) =>
                          setDrafts((values) => ({ ...values, [draftScope]: text }))
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
                            !currentSocketOwner ||
                            !subagentMessageAction(agent) ||
                            !drafts[draftScope]?.trim()
                          }
                          onPress={() => void send()}
                        >
                          {t(subagentMessageAction(agent) === "continue" ? "task.subagent_continue" : "task.send_instruction")}
                        </Button>
                      )}
                      {!subagentMessageAction(agent) ? <Text testID="mobile-subagent-send-unavailable" style={styles.secondary}>
                        {t("task.subagent_send_unavailable")}
                      </Text> : null}
                    </>
                  ) : !v3 && !capabilities.commands ? (
                    <Text style={styles.secondary}>{t("task.this_target_only_supports_viewing_transcripts_update_the")}</Text>
                  ) : null}
                  {v3 && intent ? <Button testID="mobile-subagent-query" disabled={busy || !currentSocketOwner || readyScope !== scope}
                    onPress={() => void checkIntent()}>{t("task.check_original_instruction_status")}</Button> : null}
                  {v3 && !capabilities.conversation ? <Text style={styles.secondary}>{t("task.this_target_only_supports_viewing_transcripts_update_the")}</Text> : null}
                  {notice ? (
                    <Text style={styles.secondary}>{notice}</Text>
                  ) : null}
                  {!v3 ? commands?.receipts.map((row) => (
                    <Text key={row.clientMessageId} style={styles.secondary}>
                      {row.status} · {row.clientMessageId}
                    </Text>
                  )) : null}
                  {!v3 && capabilities.stop &&
                  agent.presentation?.canStop &&
                  agent.backgroundRun ? (
                    <Button
                      testID="mobile-subagent-stop"
                      disabled={busy || !ownerAuthorized}
                      variant="danger"
                      onPress={stopAgent}
                    >
                      {t("task.stop_this_agent")}
                    </Button>
                  ) : null}
                </>
              ) : ownerAuthorized && selected && agentListOwnerKey === ownerKey ? (
                <Text accessibilityRole="alert" testID="subagent-target-not-found" style={styles.secondary}>
                  {notice || t("inbox.subagent_not_found")}
                </Text>
              ) : ownerAuthorized ? (
                <ActivityIndicator color={colors.textMuted} />
              ) : null}
  </>;
  return (
    <>
      {capabilities.discover && !hideTrigger ? (
        <Button
          testID="mobile-subagents-open"
          variant="ghost"
          disabled={!ownerGateRef.current()}
          onPress={() => setOpen(true)}
        >
          {t("task.view_subagents")}
        </Button>
      ) : null}
      {v3 ? <TaskSubagentPanel visible={open} onBack={() => selected ? select(null) : setOpen(false)}
        onRefresh={() => { setStreamRefresh({}); void refresh(); }} refreshDisabled={busy || !ownerGateRef.current()} bottomInset={bottomInset}
        information={ownerAuthorized && agentListOwnerKey === ownerKey && agent ? {
          agentId: agent.agentId, directory: agent.presentation?.directory || task.snapshot.cwd, goal: agent.presentation?.goal,
        } : undefined}
        title={ownerAuthorized && agentListOwnerKey === ownerKey && agent ? agent.agentName || agent.presentation?.goal || agent.agentId : undefined}
        onHistory={agent && capabilities.pages && !history ? () => void loadHistory() : undefined}
        onLive={agent && history ? () => setHistory(false) : undefined}
        historyDisabled={history ? false : busy || !currentSocketOwner}
        scrollable={!Boolean(ownerAuthorized && agent)}>
        {ownerAuthorized && agent ? <TaskSubagentConversation key={scope} agent={agent} history={history} view={history ? undefined : conversation} page={page}
          parentTitle={task.snapshot.title || t("task.agent")} targetLabel={authorizedServer?.label ?? profile?.server.id ?? "—"}
          directory={agent.presentation?.directory || task.snapshot.cwd} onParent={() => { select(null); setOpen(false); }}
          controls={failure || notice || intent || questions.length || history || !currentSocketOwner || !capabilities.conversation ? content : null} composer={!history && capabilities.commands && capabilities.conversation ? {
            value: drafts[draftScope] ?? "", onChange: text => setDrafts(values => ({ ...values, [draftScope]: text })),
            disabled: busy || Boolean(intent), canSend: !busy && !intent && readyScope === scope && Boolean(commands) && currentSocketOwner && conversationWritable && Boolean(subagentMessageAction(agent)) && Boolean(drafts[draftScope]?.trim()),
            onSend: () => void send(), label: t(subagentMessageAction(agent) === "continue" ? "task.subagent_continue" : "task.send_instruction"),
            running: Boolean(conversation?.snapshot.running), bottomInset,
            stopAction: capabilities.stop && agent.presentation?.canStop && agent.backgroundRun && conversation?.snapshot.running && !conversation.loading && !conversation.error ? {
              label: t("task.stop_this_agent"), disabled: busy || !currentSocketOwner, onPress: stopAgent,
            } : undefined,
          } : undefined} /> : content}
      </TaskSubagentPanel> : (
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
                disabled={busy || !ownerGateRef.current()}
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
              {content}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
      )}
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

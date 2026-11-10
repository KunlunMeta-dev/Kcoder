import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { settleAgentConversationMessages } from "@/runtime/task-runtime/agent-conversation-projection";
import { observeAgentConversation, type AgentConversationView } from "@/runtime/task-runtime/agent-conversation";

export function useSubagentConversation(task: TaskRuntime, agentId: string | undefined, scope: string,
  enabled: boolean, isCurrent: () => boolean, runId?: string, refreshToken?: object) {
  const observation = useMemo(() => ({}), [task, task.clientGeneration, agentId, scope, enabled, runId, refreshToken]);
  const [view, setView] = useState<{ scope: string; observation: object; value: AgentConversationView }>();
  const retained = useRef(view); retained.current = view;
  const gate = useRef(isCurrent); gate.current = isCurrent;
  useEffect(() => {
    if (!enabled || !agentId) return;
    return observeAgentConversation(task, agentId, value => setView({ scope, observation, value }), { isCurrent: () => gate.current(), runId,
      retainedMessages: retained.current?.scope === scope ? retained.current.value.snapshot.messages : undefined });
  }, [task, agentId, enabled, runId, observation]);
  return useMemo(() => {
    if (view?.scope !== scope) return undefined;
    if (enabled && view.observation === observation) return view.value;
    return { ...view.value, loading: enabled, snapshot: { ...view.value.snapshot,
      connected: false, running: false, activeTurnId: null,
      messages: settleAgentConversationMessages(view.value.snapshot.messages),
    } };
  }, [view, scope, enabled, observation]);
}

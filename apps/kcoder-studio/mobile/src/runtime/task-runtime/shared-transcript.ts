import type { TaskRuntime } from './core';
import { mergeReconciledMessages, readHistoryPage } from './history';
import { interactionServerIdentity } from '@/gateway/target-identity';

type Refresh = { pending: boolean; again: boolean; turn: string; sampled: boolean };
const refreshes = new WeakMap<TaskRuntime, Refresh>();

/** Read peer user messages from authoritative history; never reconstruct them from model input. */
export function refreshSharedTranscript(runtime: TaskRuntime, phase: 'started' | 'progress' | 'completed', turn: string): void {
  const client = runtime.client;
  if (!client?.supportsExperimental?.('gatewaySharedThreadsV1') || runtime.disposed) return;
  let state = refreshes.get(runtime);
  if (!state) refreshes.set(runtime, state = { pending: false, again: false, turn, sampled: false });
  if (state.turn !== turn) { state.turn = turn; state.sampled = false; }
  if (phase === 'progress' && state.sampled) return;
  if (phase === 'progress') state.sampled = true;
  if (state.pending) { state.again = true; return; }
  const generation = runtime.clientGeneration;
  const threadId = runtime.snapshot.threadId;
  const revision = runtime.transcriptMutationRevision;
  const context = runtime.reconnectContext;
  const profile = context?.profile;
  const accessToken = profile?.accessToken;
  const rpcToken = profile?.rpcToken;
  const baseUrl = profile?.baseUrl;
  const targetIdentity = context ? interactionServerIdentity(context.server) : null;
  const current = () => !runtime.disposed && runtime.client === client &&
    runtime.clientGeneration === generation && runtime.snapshot.threadId === threadId &&
    runtime.transcriptMutationRevision === revision && runtime.reconnectContext === context &&
    context?.profile === profile && profile?.accessToken === accessToken &&
    profile?.rpcToken === rpcToken && profile?.baseUrl === baseUrl &&
    (context ? interactionServerIdentity(context.server) : null) === targetIdentity;
  state.pending = true;
  void readHistoryPage(client, threadId).then(history => {
    if (!current() || history.thread?.id !== threadId) return;
    runtime.flushPendingDeltas();
    runtime.patch({ messages: mergeReconciledMessages(history.messages, runtime.snapshot.messages) });
  }).catch(() => {
    // Streaming remains usable; reconnect and the ordinary history reader can retry.
  }).finally(() => {
    state.pending = false;
    const again = state.again;
    state.again = false;
    if (again && current()) refreshSharedTranscript(runtime, 'completed', state.turn);
  });
}

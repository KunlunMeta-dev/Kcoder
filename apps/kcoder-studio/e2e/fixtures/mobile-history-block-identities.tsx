import { useMemo } from 'react';
import { CachedSessionView } from '@/features/task/CachedSessionView';
import { projectConfirmedTranscript, decodeConfirmedTranscript } from '@/storage/session-transcript-projection';
import type { SessionTranscriptScope } from '@/storage/session-transcript-scope';

// Synthetic legacy history only; mounting this screen cannot open a real session.
const scope: SessionTranscriptScope = {
  version: 1,
  profile: { id: 'identity-fixture', baseUrl: 'https://identity-fixture.invalid', authorizationGeneration: 'fixture', authMode: 'legacy' },
  target: { id: 'fixture', transport: 'local', connectionFingerprint: '0'.repeat(64), principalId: null, role: null, workspacePath: '/workspace/fixture' },
  cwd: '/workspace/fixture', threadId: 'identity-history',
};
function cachedHistory() {
  const record = projectConfirmedTranscript(scope, { messages: [
    { id: 'user', role: 'user', content: 'HISTORY_IDENTITY_QUESTION', status: 'completed', timestampMs: 1 },
    { id: 'reply', role: 'assistant', content: 'HISTORY_IDENTITY_FINAL', status: 'completed', timestampMs: 2, blocks: [
      { id: 'legacy-source-text', type: 'text', content: 'HISTORY_IDENTITY_REPEATED' },
      { id: 'tool-a', type: 'tool', tool_name: 'Read', status: 'done', tool_output: 'FIRST_TOOL_RESULT' },
      { id: 'legacy-source-text', type: 'text', content: 'HISTORY_IDENTITY_REPEATED' },
      { id: 'tool-b', type: 'tool', tool_name: 'Read', status: 'done', tool_output: 'SECOND_TOOL_RESULT' },
      { id: 'legacy-source-text', type: 'text', content: 'HISTORY_IDENTITY_DIFFERENT' },
    ] },
  ], hasMoreBefore: false }, { title: 'History identity regression', updatedAt: 2 });
  const cached = decodeConfirmedTranscript(JSON.stringify(record), scope);
  if (!cached) throw new Error('Synthetic history must decode');
  return cached;
}
export default function HistoryBlockIdentitiesFixture() {
  const cached = useMemo(cachedHistory, []);
  const owner = useMemo(() => ({}), []);
  return <CachedSessionView cached={cached} owner={owner} topInset={0} bottomInset={0}
    offline composerDraft="" onBack={() => {}} onRetry={() => {}} />;
}

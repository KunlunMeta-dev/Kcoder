import { useEffect, useMemo, useState } from 'react';
import { CachedSessionView } from '@/features/task/CachedSessionView';
import { projectConfirmedTranscript, decodeConfirmedTranscript } from '@/storage/session-transcript-projection';
import type { SessionTranscriptScope } from '@/storage/session-transcript-scope';

// Synthetic reading fixture; this screen cannot connect to a Gateway or send a turn.
const scope: SessionTranscriptScope = {
  version: 1,
  profile: { id: 'reading-fixture', baseUrl: 'https://reading.invalid', authorizationGeneration: 'fixture', authMode: 'legacy' },
  target: { id: 'reading', transport: 'local', connectionFingerprint: '0'.repeat(64), principalId: null, role: null, workspacePath: '/workspace/reading' },
  cwd: '/workspace/reading', threadId: 'longform-reading',
};
const content = '__LONGFORM_CONTENT__';

export default function LongformReadingFixture() {
  const [suffix, setSuffix] = useState('');
  useEffect(() => {
    // Only this isolated fixture accepts deterministic transcript updates from its test owner.
    const append = (event: Event) => { const value = (event as CustomEvent<unknown>).detail; if (typeof value === 'string') setSuffix(previous => previous + value); };
    window.addEventListener('kcoder-reading-fixture-append', append);
    return () => window.removeEventListener('kcoder-reading-fixture-append', append);
  }, []);
  const cached = useMemo(() => {
    const record = projectConfirmedTranscript(scope, { messages: [
      { id: 'reading-question', role: 'user', content: '整理一下长文阅读体验。', status: 'completed', timestampMs: 1 },
      { id: 'reading-reply', role: 'assistant', content: content + suffix, status: 'completed', timestampMs: 2 },
    ], hasMoreBefore: false }, { title: '长文与 Markdown', updatedAt: 2 });
    const restored = decodeConfirmedTranscript(JSON.stringify(record), scope);
    if (!restored) throw new Error('Reading fixture must preserve its cached transcript');
    return restored;
  }, [suffix]);
  const owner = useMemo(() => ({}), []);
  return <CachedSessionView cached={cached} owner={owner} topInset={0} bottomInset={0}
    offline composerDraft="" onBack={() => {}} onRetry={() => {}} />;
}

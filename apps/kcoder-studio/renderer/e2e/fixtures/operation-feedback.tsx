import { useEffect, useRef, useState } from 'react'
import { ScrollableMessageArea } from '../../src/components/chat/ScrollableMessageArea'
import { ProviderRetryStatus } from '../../src/components/chat/ProviderRetryStatus'
import { Button } from '../../src/components/ui/button'
import type { WorkbenchMessage } from '../../src/types/workbench'
import { ToolPathPreviewConsumer } from '../../src/kcoder/toolPathPreview'

const retryTarget = 'feedback-retry-target'
const retryTask = 'feedback-retry-task'

// Deterministic screenshot regressions: native failures and Provider availability are not simulated as successes.
export function OperationFeedbackFixture() {
  const [phase, setPhase] = useState<'failed' | 'streaming' | 'completed'>('failed')
  const [retry, setRetry] = useState(false)
  const [action, setAction] = useState('')
  const [navigationPortal, setNavigationPortal] = useState<HTMLDivElement | null>(null)
  const query = new URLSearchParams(location.search)
  const useNavigationPortal = query.has('navigationPortal')
  const retryTail = query.has('retryTail')
  const failureScenario = query.get('failures')
  const disclosureScenario = query.get('disclosure')
  const sameAttempt = failureScenario === 'same-attempt' || failureScenario === 'live'
  const [progress] = useState(() => new ToolPathPreviewConsumer())
  const client = useRef({})
  const sequence = useRef(0)
  const attempt = useRef(0)
  const pendingEdit = useRef<((accepted: boolean) => void) | null>(null)
  useEffect(() => () => progress.dispose(), [progress])
  useEffect(() => () => pendingEdit.current?.(false), [])
  const reportRetry = (nextAttempt: number) => {
    const send = (method: string, extra: Record<string, unknown> = {}) => progress.handle(method, {
      serverId: retryTarget, threadId: 'feedback-retry-thread', turnId: 'feedback-retry-turn',
      sequence: ++sequence.current, ...extra,
    }, retryTarget, retryTask, client.current)
    if (!nextAttempt) {
      send('turn/completed')
    } else {
      if (!attempt.current) send('turn/started')
      send('item/event', { event: { type: 'system_notice', kind: 'provider_retry', request_kind: 'main',
        attempt: nextAttempt, max_retries: 5, retry_after_ms: 15000,
        provider: 'openai', model: 'Baize-Omni-Sense',
        reason: 'Provider error: network_error. Response details withheld.', timeout_kind: 'transport',
        elapsed_ms: 2870, transport_elapsed_ms: 22319, turn_elapsed_ms: 22368,
        first_token_ms: 320, last_token_ms: 1200,
      } })
    }
    attempt.current = nextAttempt
  }
  const [receivedAt] = useState(() => Date.now() - 30_000)
  const messages: WorkbenchMessage[] = Array.from({ length: failureScenario ? 5 : 3 }, (_, index) => index + 1).flatMap<WorkbenchMessage>(index => [
    ...(sameAttempt && index > 1 ? [] : [{
      id: `input-${index}`,
      role: 'user' as const,
      content: `Request ${index}`,
      createdAt: '',
      status: 'done' as const,
    }]),
    {
      id: `failed-${index}`,
      role: 'assistant',
      content: '',
      createdAt: '',
      status: failureScenario === 'live' ? 'streaming' : 'failed',
      turnId: sameAttempt ? 'turn-1' : `turn-${index}`,
      attemptId: sameAttempt ? 'attempt-1' : `attempt-${index}`,
      error: failureScenario === 'live' ? undefined : `Saved diagnostic ${index}`,
      blocks: [
        {
          id: `tool-${index}`,
          type: 'tool',
          toolName: 'read',
          toolInput: { path: 'README.md' },
          toolOutput: 'Owned fixture',
          status: 'done',
          createdAt: 1_790_000_000_000,
          completedAt: 1_790_000_000_250,
        },
      ],
    },
  ])
  if (disclosureScenario) {
    const owner: WorkbenchMessage = { ...messages[1], id: 'process-owner', status: 'streaming', error: undefined,
      turnId: 'disclosure-turn', attemptId: 'disclosure-attempt' }
    const sibling: WorkbenchMessage = { ...owner, id: 'process-sibling', blocks: disclosureScenario === 'question' ? [{
      id: 'question', type: 'tool', toolName: 'AskUserQuestion', status: phase === 'completed' ? 'done' : 'pending',
      createdAt: 1_790_000_001_000, renderPayload: { kind: 'request_user_input', requestId: 42,
        resolved: phase === 'completed', questions: [{ id: 'destination', question: 'Which destination?', options: [] }] },
    }] : [{ id: 'empty-image', type: 'tool', toolName: 'image_generation', status: 'done',
      createdAt: 1_790_000_001_000 }] }
    messages.splice(0, messages.length, ...(disclosureScenario === 'editing'
      ? [{ id: 'edit-user', role: 'user' as const, content: 'Original question', status: 'done' as const, createdAt: '' },
        { ...owner, status: 'done' as const, blocks: [], content: 'Owned answer' }]
      : disclosureScenario === 'scope'
        ? [{ ...owner, status: 'failed' as const, error: 'Owned scope diagnostic' }] : [owner, sibling]))
  }
  if (phase !== 'failed' && disclosureScenario !== 'scope' && disclosureScenario !== 'editing')
    messages.push({
      id: 'later-attempt',
      role: 'assistant',
      createdAt: '',
      status: phase === 'streaming' ? 'streaming' : 'done',
      content: phase === 'streaming' ? 'Working on the next attempt' : 'Later response',
    })
  return (
    <main className="flex h-dvh min-w-0 flex-col bg-background text-text-primary">
      <div className="flex flex-wrap gap-2 border-b border-border p-2">
        <Button size="sm" onClick={() => setPhase('failed')} data-testid="feedback-show-failed">
          Failed
        </Button>
        <Button
          size="sm"
          onClick={() => setPhase('streaming')}
          data-testid="feedback-show-streaming"
        >
          Streaming
        </Button>
        <Button
          size="sm"
          onClick={() => setPhase('completed')}
          data-testid="feedback-show-completed"
        >
          Completed
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (retryTail) reportRetry(retry ? 0 : 4)
            setRetry(value => !value)
          }}
          data-testid="feedback-show-retry"
        >
          Retry report
        </Button>
        {retryTail && <Button size="sm" data-testid="feedback-retry-next" onClick={() => reportRetry(5)}>
          Fifth retry
        </Button>}
        {disclosureScenario === 'editing' && <Button size="sm" data-testid="feedback-edit-ack" onClick={() => {
          pendingEdit.current?.(true)
          pendingEdit.current = null
        }}>Acknowledge original edit</Button>}
        <output data-testid="feedback-action">{action}</output>
      </div>
      {retry && !retryTail && (
        <div className="p-3">
          <ProviderRetryStatus
            activity={{
              attempt: 4,
              maxRetries: 5,
              receivedAtMs: receivedAt,
              retryAfterMs: 15000,
              diagnostics: { reason: 'network_error', previousAttemptElapsedMs: 2870 },
            }}
          />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1" data-testid="feedback-conversation-panel">
      {useNavigationPortal && <div ref={setNavigationPortal} data-testid="feedback-navigation-overlay"
        className="pointer-events-none absolute inset-0" />}
      <ScrollableMessageArea
        messages={messages}
        conversationKey={disclosureScenario === 'scope' || disclosureScenario === 'editing'
          ? `owned-feedback-${phase}` : 'owned-operation-feedback'}
        scrollTestId="operation-feedback-scroll"
        turnNavigationPortalTarget={navigationPortal}
        toolsCatalogServerId={retryTail ? retryTarget : undefined}
        toolsCatalogTaskId={retryTail ? retryTask : undefined}
        stickyFooter={retryTail ? <div data-testid="feedback-composer" className="h-40 border-t border-border bg-background" /> : undefined}
        onRetryFailedMessage={message => setAction(message.id)}
        onSwitchModelForFailedMessage={message => setAction(message.id)}
        canEditLastUserMessage={disclosureScenario === 'editing'}
        onEditLastUserMessage={disclosureScenario === 'editing'
          ? () => new Promise<boolean>(resolve => { pendingEdit.current = resolve }) : undefined}
      />
      </div>
    </main>
  )
}

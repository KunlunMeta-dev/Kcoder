import { useState } from 'react'
import { contextPreflightRecovery } from '@wegent/chat-core'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../../src/components/chat/MessageList'
import '../../src/i18n'
import '../../src/styles/globals.css'

export function Fixture() {
  const [available, setAvailable] = useState(false)
  const [continued, setContinued] = useState(false)
  const [submissions, setSubmissions] = useState(0)
  const [selections, setSelections] = useState(0)
  return (
    <main className="mx-auto max-w-3xl p-6">
      <button onClick={() => setAvailable(true)}>读取已保存的检查点</button>
      <output data-testid="context-submissions">{submissions}</output>
      <output data-testid="context-model-selections">{selections}</output>
      <MessageList
        messages={[
          {
            id: 'context-attempt',
            turnId: 'turn-1',
            attemptId: 'turn-1',
            role: 'assistant',
            status: 'failed',
            content: '',
            createdAt: '',
            continuationAccepted: continued,
            error:
              'Context request blocked before sending: system instructions and tool definitions exceed the input limit.',
            providerFailure: {
              category: 'context_length_exceeded',
              recovery_action: 'needs_human',
              retryable: false,
              resume_safe: false,
              context_preflight: {
                request_tokens: 48264,
                input_limit_tokens: 28672,
                count_is_exact: false,
                compaction: 'fixed_overhead_exceeds_limit',
                continuation_available: available,
              },
            },
          },
        ]}
        onSwitchModelForFailedMessage={message => {
          setSelections(n => n + 1)
          if (contextPreflightRecovery(message) === 'select_model') return
          setSubmissions(n => n + 1)
          setContinued(true)
        }}
      />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)

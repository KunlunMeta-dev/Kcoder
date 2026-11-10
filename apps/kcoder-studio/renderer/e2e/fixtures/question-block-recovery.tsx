import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../../src/components/chat/MessageList'
import type { RequestUserInputResponse } from '../../src/types/api'
import type { ProcessingBlock } from '../../src/types/workbench'
import '../../src/i18n'
import '../../src/styles/globals.css'

export function Fixture() {
  const [revision, setRevision] = useState(0)
  const [attempts, setAttempts] = useState(0)
  const [pending, setPending] = useState<((accepted: boolean) => void) | null>(null)
  const [response, setResponse] = useState<RequestUserInputResponse>()
  const blocks: ProcessingBlock[] = [
    {
      id: `read-${revision}`,
      type: 'tool',
      toolName: 'Read',
      status: 'done',
    },
    {
      id: `question-${revision}`,
      type: 'tool',
      toolName: 'AskUserQuestion',
      status: 'pending',
      renderPayload: {
        kind: 'request_user_input',
        requestId: 41,
        itemId: 'original-question',
        threadId: 'original-thread',
        turnId: 'original-turn',
        appServerEpoch: 'original-epoch',
        questions: [{ id: 'choice', question: 'Which source?', options: [] }],
      },
    },
  ]
  return (
    <main className="p-6">
      <textarea aria-label="普通对话草稿" data-testid="ordinary-composer" />
      <button data-testid="rebuild-blocks" onClick={() => setRevision(value => value + 1)}>
        恢复历史
      </button>
      <button data-testid="reject-send" onClick={() => pending?.(false)}>
        发送失败回执
      </button>
      <output data-testid="send-attempts">{attempts}</output>
      <output data-testid="submitted-response">{JSON.stringify(response)}</output>
      <MessageList
        messages={[
          {
            id: 'original-message',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-11-10T06:00:00.000Z',
            blocks,
          },
        ]}
        onRequestUserInputSubmit={value => {
          setResponse(value)
          setAttempts(count => count + 1)
          return new Promise<boolean>(resolve => {
            setPending(() => resolve)
          })
        }}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)

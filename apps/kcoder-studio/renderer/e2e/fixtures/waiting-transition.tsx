import { useRef, useState } from 'react'
import { ScrollableMessageArea } from '../../src/components/chat/ScrollableMessageArea'
import { rememberConversationProcessingWindow } from '../../src/features/appearance/conversationProcessPreferences'
import type { WorkbenchMessage } from '../../src/types/workbench'

const history: WorkbenchMessage[] = Array.from({ length: 18 }, (_, index) => ({
  id: `history-${index}`,
  role: 'user',
  content: `Earlier message ${index}`,
  status: 'done',
  createdAt: '2026-11-01T00:00:00Z',
}))

export function WaitingTransitionFixture() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [startedAt] = useState(() => Date.now())
  const newChat = new URLSearchParams(location.search).has('newChat')
  const [key] = useState(() => {
    const windowed = new URLSearchParams(location.search).has('windowed')
    const conversationKey = windowed ? 'fixture-waiting-windowed' : 'fixture-waiting'
    rememberConversationProcessingWindow(conversationKey, windowed)
    rememberConversationProcessingWindow(`${conversationKey}:confirmed`, windowed)
    return conversationKey
  })
  const [phase, setPhase] = useState<'waiting' | 'confirmed' | 'empty' | 'thinking' | 'response'>(
    'waiting'
  )
  const visibleHistory = newChat ? history.slice(-1) : history
  const messages: WorkbenchMessage[] =
    phase === 'waiting' || phase === 'confirmed'
      ? visibleHistory
      : [
          ...visibleHistory,
          {
            id: 'response',
            role: 'assistant',
            status: 'streaming',
            content: phase === 'response' ? '第一段回复' : '',
            createdAt: '2026-11-01T00:00:01Z',
            blocks:
              phase === 'thinking'
                ? [
                    {
                      id: 'reasoning',
                      subtaskId: 'fixture-turn',
                      type: 'thinking',
                      content: '核对任务要求。',
                      status: 'streaming',
                      createdAt: startedAt,
                    },
                  ]
                : undefined,
          },
        ]
  return (
    <div className="flex h-dvh flex-col">
      <div>
        <button data-testid="fixture-empty-stream" onClick={() => setPhase('empty')}>
          空流
        </button>
        <button data-testid="fixture-confirm-conversation" onClick={() => setPhase('confirmed')}>
          确认会话
        </button>
        <button data-testid="fixture-first-response" onClick={() => setPhase('response')}>
          首段输出
        </button>
        <button data-testid="fixture-first-thinking" onClick={() => setPhase('thinking')}>
          开始思考
        </button>
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <ScrollableMessageArea
          key={newChat && phase !== 'waiting' ? `${key}:confirmed` : key}
          className="h-full"
          scrollerClassName="overflow-visible scrollbar-none"
          externalScrollRef={scrollRef}
          stickyFooter={<div className="h-32 bg-background" />}
          scrollTestId="fixture-waiting-scroll"
          messages={messages}
          isWaitingForAssistant={phase !== 'response'}
          conversationKey={newChat && phase !== 'waiting' ? `${key}:confirmed` : key}
        />
      </div>
    </div>
  )
}

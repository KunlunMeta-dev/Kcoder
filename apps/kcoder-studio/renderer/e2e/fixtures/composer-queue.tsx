import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatInput } from '../../src/components/chat/ChatInput'
import type { QueuedWorkbenchMessage } from '../../src/types/workbench'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// UI-only: reproduce the local dispatch -> receipt projection with synthetic data.
// No Gateway, native task, model or personal profile participates in this fixture.
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark')
await i18n.changeLanguage('en')

export function ComposerQueueFixture() {
  const [value, setValue] = useState('')
  const [messages, setMessages] = useState<QueuedWorkbenchMessage[]>([])
  const [phase, setPhase] = useState('idle')
  const [fast, setFast] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const clear = () => {
    clearTimeout(timer.current)
    setMessages([])
    setPhase('idle')
  }
  return (
    <main className="flex h-dvh flex-col gap-3 bg-background p-4 text-text-primary">
      <div className="flex flex-wrap items-center gap-3">
        <label>
          <input
            data-testid="fixture-fast-dispatch"
            type="checkbox"
            checked={fast}
            onChange={event => setFast(event.target.checked)}
          />{' '}
          Fast receipt
        </label>
        <button
          data-testid="fixture-enqueue"
          onClick={() =>
            setMessages(previous => [
              ...previous,
              {
                id: 'waiting',
                content: 'Actually waiting',
                status: 'queued',
                createdAt: new Date().toISOString(),
              },
            ])
          }
        >
          Queue another
        </button>
        <button
          data-testid="fixture-fail"
          onClick={() =>
            setMessages(previous =>
              previous.map(message => ({
                ...message,
                status: 'failed',
                error: 'Synthetic dispatch failure',
              }))
            )
          }
        >
          Fail dispatch
        </button>
        <button data-testid="fixture-clear" onClick={clear}>
          Clear
        </button>
        <output data-testid="fixture-dispatch-phase">{phase}</output>
      </div>
      <div className="mt-auto" data-testid="fixture-composer">
        <ChatInput
          value={value}
          onChange={setValue}
          disabled={false}
          variant={query.get('variant') === 'compact' ? 'compact' : 'desktop'}
          queuedMessages={messages}
          guidanceMessages={[]}
          onCancelQueuedMessage={id =>
            setMessages(previous => previous.filter(message => message.id !== id))
          }
          onSubmit={text => {
            clearTimeout(timer.current)
            setMessages([
              {
                id: 'dispatch',
                content: text ?? value,
                status: 'sending',
                createdAt: new Date().toISOString(),
              },
            ])
            setValue('')
            setPhase('sending')
            if (fast)
              timer.current = setTimeout(() => {
                setMessages([])
                setPhase('acknowledged')
              }, 80)
          }}
        />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<ComposerQueueFixture />)

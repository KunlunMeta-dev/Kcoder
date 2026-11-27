import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import { RetainedPage } from '../../src/components/layout/retainedPages'
import { TurnProcessSummary } from '../../src/components/chat/TurnProcessSummary'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'

// UI-only transport: controlled calibration responses, no Gateway, tools or model calls.
const startedAt = Date.now()
let reads = 0
const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
registerGatewayCommandTransport((command, args) => {
  if (command !== 'local_executor_request' || (args as { method?: string })?.method !== 'runtime.clock.read')
    throw new Error('Unexpected clock fixture request')
  reads++
  window.dispatchEvent(new Event('fixture-clock-read'))
  if (reads === 1) return { sampledAtMs: startedAt + 10_000 }
  return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
})
await i18n.changeLanguage('zh-CN')

export function ConnectionClockFixture() {
  const [active, setActive] = useState(true)
  const [completed, setCompleted] = useState(false)
  const [readCount, setReadCount] = useState(reads)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const update = () => setReadCount(reads)
    update()
    window.addEventListener('fixture-clock-read', update)
    return () => window.removeEventListener('fixture-clock-read', update)
  }, [])
  return <main className="space-y-4 bg-background p-4 text-text-primary">
    <p>UI-only calibration fixture</p>
    <output data-testid="clock-read-count">{readCount}</output>
    <div className="flex flex-wrap gap-4">
      <button data-testid="clock-toggle" onClick={() => setActive(value => !value)}>Toggle page</button>
      <button data-testid="clock-fail" onClick={() => pending.shift()?.reject(new Error('offline'))}>Fail sample</button>
      <button data-testid="clock-older" onClick={() => pending.shift()?.resolve({ sampledAtMs: startedAt + 1000 })}>Older sample</button>
      <button data-testid="clock-finish" onClick={() => setCompleted(true)}>Finish</button>
    </div>
    <RetainedPage open={active}>
      <TurnProcessSummary presentation={{ key: 'fixture-attempt', ownerMessageId: 'fixture-message',
        status: completed ? 'completed' : 'running', canUseSummary: true, canCollapse: completed,
        hasThinking: true, hasTools: false, startedAt, completedAt: completed ? startedAt + 42_000 : undefined,
        blocks: [], }} serverId="fixture-target" expanded onToggle={() => {}} buttonRef={buttonRef} />
    </RetainedPage>
  </main>
}
createRoot(document.getElementById('root')!).render(<ConnectionClockFixture />)

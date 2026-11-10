import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RequestUserInputCard, type RequestUserInputPayload } from '../../src/components/chat/RequestUserInputCard'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import '../../src/i18n'
import '../../src/styles/globals.css'

export function Fixture() {
  const [replacement, setReplacement] = useState(false)
  const [answers, setAnswers] = useState<unknown[]>([])
  const finish = useRef<(value: boolean) => void>(() => {})
  const binding = new URLSearchParams(location.search).get('binding')
  if (!['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch'].includes(binding ?? '')) throw new Error('Invalid binding')
  const payload: RequestUserInputPayload = {
    requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    ...(replacement ? { [binding!]: 'replacement' } : {}),
    questions: [{ id: 'choice', question: 'Which source?', options: [] }],
  }
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p>受控问题生命周期 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" />
    <button data-testid="replace-owner" onClick={() => setReplacement(true)}>读取另一生命周期问题</button>
    <button data-testid="reject-old-answer" onClick={() => finish.current(false)}>读取旧回答拒绝</button>
    <output data-testid="answers">{JSON.stringify(answers)}</output>
    <RequestUserInputCard payload={payload} onSubmit={response => {
      setAnswers(current => [...current, response])
      if (!replacement) return new Promise<boolean>(resolve => { finish.current = resolve })
      return true
    }} />
  </main>
}

const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)
createRoot(document.getElementById('root')!).render(<Fixture />)

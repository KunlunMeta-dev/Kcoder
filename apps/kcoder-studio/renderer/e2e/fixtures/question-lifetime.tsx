import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RequestUserInputCard, type RequestUserInputPayload } from '../../src/components/chat/RequestUserInputCard'
import { createRequestUserInputAliasTracker, observeRequestUserInputAliases, isHiddenRequestUserInputBlock, requestUserInputSettledKeysForPayloads } from '../../src/components/chat/requestUserInputMessages'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import '../../src/i18n'
import '../../src/styles/globals.css'

export function Fixture() {
  const [replacement, setReplacement] = useState(false)
  const [answers, setAnswers] = useState<unknown[]>([])
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const finish = useRef<(value: boolean) => void>(() => {})
  const binding = new URLSearchParams(location.search).get('binding')
  const restoreAlias = new URLSearchParams(location.search).has('restoreAlias')
  const settle = new URLSearchParams(location.search).has('settle')
  const runField = binding?.startsWith('sourceAgent.backgroundRun.') ? binding.split('.').at(-1) : undefined
  if (!['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch',
    'sourceAgent.backgroundRun.parentSessionId', 'sourceAgent.backgroundRun.agentId'].includes(binding ?? '')) throw new Error('Invalid binding')
  const payload: RequestUserInputPayload = {
    kind: 'request_user_input',
    requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    ...(runField ? { sourceAgent: { parentSessionId: 'parent', agentId: 'worker',
      backgroundRun: { parentSessionId: 'parent', agentId: 'worker', runId: 'run',
        ...(replacement ? { [runField]: 'replacement' } : {}) } } } : {}),
    ...(restoreAlias
      ? replacement ? {} : { requestId: undefined, itemId: 'restored-question' }
      : replacement && !runField ? { [binding!]: 'replacement' } : {}),
    questions: [{ id: 'choice', question: 'Which source?', options: [] }],
  }
  const historical = { ...payload, requestId: undefined, itemId: 'restored-question',
    [binding!]: 'previous', resolved: true }
  const [tracker] = useState(() => {
    const initial = createRequestUserInputAliasTracker()
    if (restoreAlias) observeRequestUserInputAliases(initial, [historical, payload])
    return initial
  })
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p>受控问题生命周期 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" />
    <button data-testid="replace-owner" onClick={() => {
      if (restoreAlias) observeRequestUserInputAliases(tracker, [
        historical, { ...payload, requestId: 7, itemId: 'question' },
      ])
      setReplacement(true)
    }}>读取另一生命周期问题</button>
    <button data-testid="reject-old-answer" onClick={() => finish.current(false)}>读取旧回答拒绝</button>
    <output data-testid="answers">{JSON.stringify(answers)}</output>
    {!isHiddenRequestUserInputBlock({ id: 'question', type: 'tool', toolName: 'AskUserQuestion',
      status: 'pending', renderPayload: payload }, hidden) && <RequestUserInputCard payload={payload} aliasesByKey={restoreAlias ? tracker.aliasesByKey : undefined} onSubmit={response => {
      setAnswers(current => [...current, response])
      if (settle) {
        setHidden(new Set(requestUserInputSettledKeysForPayloads([payload], response, new Map())))
        return true
      }
      if (!replacement) return new Promise<boolean>(resolve => { finish.current = resolve })
      return true
    }} />}
  </main>
}

const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)
createRoot(document.getElementById('root')!).render(<Fixture />)

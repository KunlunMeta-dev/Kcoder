import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolBlocksDisplay } from '../../src/components/chat/blocks/ToolBlocksDisplay'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from '../../src/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '../../src/components/chat/RequestUserInputCard'
import type { WorkbenchMessage } from '../../src/types/workbench'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import '../../src/i18n'
import '../../src/styles/globals.css'

const field = new URLSearchParams(location.search).get('binding')
if (!['threadId', 'turnId', 'appServerEpoch', 'resolved'].includes(field ?? '')) throw new Error('Invalid binding')
const reusedHistory = new URLSearchParams(location.search).has('reusedHistory')
const payload: RequestUserInputPayload = {
  kind: 'request_user_input', requestId: 7, itemId: 'question',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Which source?', options: [] }],
}
const historical = reusedHistory
  ? { ...payload, [field!]: 'previous', resolved: true }
  : { ...payload, requestId: undefined, itemId: 'retired-question', resolved: true }
const tracker = createRequestUserInputAliasTracker()
if (field === 'resolved') {
  observeRequestUserInputAliases(tracker, [historical])
  observeRequestUserInputAliases(tracker, [historical, payload])
}
const original: WorkbenchMessage = {
  id: 'original', role: 'assistant', content: '', status: 'done', createdAt: '2026-11-10',
  blocks: [{ id: 'question', type: 'tool', status: 'pending', toolName: 'AskUserQuestion', renderPayload: payload }],
}

export function Fixture() {
  const [messages, setMessages] = useState(reusedHistory ? [{ ...original, id: 'historical', blocks: [
    { ...original.blocks![0], id: 'historical-question', status: 'done', renderPayload: historical },
  ] }, original] : [original])
  const [hidden, setHidden] = useState(new Set<string>())
  const readAnswer = (stale: boolean) => {
    const response = { ...(stale && field === 'resolved'
      ? { itemId: historical.itemId }
      : { ...payload, ...(stale ? { [field!]: 'previous' } : {}) }),
      answers: { choice: { answers: ['Previously saved answer'] } } }
    setHidden(new Set(requestUserInputRelatedKeysForPayloads(
      field === 'resolved' || reusedHistory ? [historical, payload] : [payload], response, tracker.aliasesByKey)))
    setMessages(current => applyRequestUserInputResponseToMessages(current, response))
  }
  return <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <p>受控答案回执 fixture · 不连接 Gateway、Native 或模型</p>
    <textarea aria-label="普通对话草稿" />
    <button data-testid="read-stale-answer" onClick={() => readAnswer(true)}>读取旧答案回执</button>
    <button data-testid="read-current-answer" onClick={() => readAnswer(false)}>读取原问题答案回执</button>
    <ToolBlocksDisplay blocks={messages.flatMap(message => message.blocks ?? [])} isStreaming
      hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={() => false} />
  </main>
}

const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)
createRoot(document.getElementById('root')!).render(<Fixture />)

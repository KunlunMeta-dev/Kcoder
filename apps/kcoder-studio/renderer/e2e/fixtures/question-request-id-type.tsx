import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RequestUserInputPayload } from '../../src/components/chat/RequestUserInputCard'
import { ToolBlocksDisplay } from '../../src/components/chat/blocks/ToolBlocksDisplay'
import { requestUserInputSettledKeysForPayloads } from '../../src/components/chat/requestUserInputMessages'
import type { RequestUserInputResponse } from '../../src/types/api'
import '../../src/i18n'
import '../../src/styles/globals.css'

const payloads: RequestUserInputPayload[] = [1, '1'].map(requestId => ({
  kind: 'request_user_input', requestId, itemId: 'question-1',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'typed-choice', question: 'Which original source?', options: [{ label: 'Keep original' }] }],
}))
const blocks = payloads.map((renderPayload, index) => ({
  id: `typed-block-${index}`, type: 'tool' as const, toolName: 'AskUserQuestion',
  status: 'pending' as const, renderPayload,
}))

export function Probe() {
  const [hidden, setHidden] = useState(new Set<string>())
  const [sent, setSent] = useState<RequestUserInputResponse[]>([])
  return <main data-testid="typed-request-probe">
    <p>Model-independent question identity fixture</p>
    <ToolBlocksDisplay blocks={blocks} isStreaming hiddenRequestUserInputIds={hidden}
      onRequestUserInputSubmit={response => {
        setSent(previous => [...previous, response])
        setHidden(new Set(requestUserInputSettledKeysForPayloads(payloads, response, new Map())))
        return true
      }} />
    <output data-testid="typed-sent">{JSON.stringify(sent)}</output>
    <input data-testid="typed-composer" aria-label="Ordinary draft" />
  </main>
}

createRoot(document.getElementById('root')!).render(<Probe />)

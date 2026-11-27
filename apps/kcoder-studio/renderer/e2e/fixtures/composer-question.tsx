import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PaneComposer } from '../../src/components/layout/workbench/PaneComposer'
import { createRequestUserInputAliasTracker } from '../../src/components/chat/requestUserInputMessages'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import type { QueuedWorkbenchMessage } from '../../src/types/workbench'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

await i18n.changeLanguage('zh-CN')
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)

// Exercise the production composer container with owned, model-independent state.
export function App() {
  const [pending, setPending] = useState(false)
  const [input, setInput] = useState('')
  const [queued, setQueued] = useState<QueuedWorkbenchMessage[]>([
    {
      id: 'first',
      content: '等待当前回合后检查测试',
      status: 'queued',
      createdAt: '2026-11-15T00:00:00Z',
    },
    { id: 'second', content: '随后检查结果', status: 'queued', createdAt: '2026-11-15T00:00:01Z' },
  ])
  const tracker = useRef(createRequestUserInputAliasTracker())
  const model = {
    paneKey: 'owned-question-pane',
    paneActive: false,
    devices: [],
    upgradingDevices: {},
    workflowRefs: [],
    projectChatWithModelSelectorSignal: {
      scopeKey: 'owned-question-pane',
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      setSelectedModel: () => {},
      setSelectedModelOption: () => {},
      toggleSkill: () => {},
      handleFileSelect: async () => {},
      removeAttachment: async () => {},
      listLocalSkills: async () => [],
      listLocalApps: async () => [],
    },
    t: (_key: string, fallback: string) => fallback,
    pendingRequestUserInput: pending
      ? {
          requestId: 41,
          itemId: 'blocking-question',
          questions: [{ id: 'choice', question: '下一步如何继续？', options: [] }],
        }
      : undefined,
    paneQueuedMessages: queued,
    paneSession: {
      messages: [],
      input,
      setInput,
      status: { isSubmitting: false },
      requestUserInputAliasTrackerRef: tracker,
      sendRequestUserInputResponse: async () => {
        setPending(false)
        return true
      },
      ignoreRequestUserInput: () => setPending(false),
      cancelQueuedMessage: (id: string) => setQueued(rows => rows.filter(row => row.id !== id)),
    },
  } as unknown as Parameters<typeof PaneComposer>[0]['model']
  return (
    <main className="relative min-h-screen bg-background py-6 text-text-primary">
      <button data-testid="fixture-ask" onClick={() => setPending(true)}>
        模型提问
      </button>
      <PaneComposer model={model} />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)

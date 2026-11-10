import { createRoot } from 'react-dom/client'
import { TaskPendingInteractions } from '../../src/features/task-workspace/interactions/TaskPendingInteractions'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import type { TaskInteractionSnapshotV1 } from '../../../shared/generated/contracts'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// The actual form and transport run against synthetic original receipts only.
const address = { deviceId: 'fixture-target', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
const snapshot: TaskInteractionSnapshotV1 = {
  schemaVersion: 1, threadId: address.threadId, observationState: 'observed', items: [{
    reference: { attemptId: 'attempt', selector: {
      serverId: 'process', threadId: address.threadId, turnId: 'turn', requestId: 2000001,
      appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
    } },
    state: 'pending', presentation: { approval: null, questions: [{
      id: 'choice', header: 'Original question', question: 'Which sources?', isOther: true,
      multiSelect: true, options: [
        { label: 'First source', description: 'Original first choice' },
        { label: 'Second source', description: 'Original second choice' },
      ],
    }] },
  }],
}
// Keep protocol labels distinct even when their visible text looks similar.
if (new URLSearchParams(location.search).has('exactLabels')) {
  snapshot.items[0].presentation.questions[0].options[1].label = '\t First source \u00a0'
}
if (new URLSearchParams(location.search).has('exactItemIds')) {
  snapshot.items[0].presentation.questions = ['choice', ' choice\u00a0'].map((id, index) => ({
    id, header: `Original item ${index + 1}`, question: `Answer item ${index + 1}`,
    isOther: true, options: [],
  }))
}
const planChoiceId = new URLSearchParams(location.search).get('planChoiceId')
if (planChoiceId === 'implement' || planChoiceId === 'strategy') {
  snapshot.items[0].presentation.questions = [
    { id: planChoiceId, header: 'Strategy', question: 'How should work proceed?', isOther: false,
      options: [{ label: '执行此计划', description: '' }, { label: 'Review first', description: '' }] },
    { id: 'scope', header: 'Scope', question: 'Which scope?', isOther: false,
      options: [{ label: 'All modules', description: '' }, { label: 'Selected module', description: '' }] },
  ]
}
const heldReads = new Set<() => void>()
const probe = {
  nextRead: 'ready' as 'ready' | 'hold' | 'fail',
  readCalls: 0,
  responses: [] as unknown[],
  rejectResponse() { snapshot.items[0].state = 'pending' },
  setWorkspacePath(workspacePath: string) { renderView(workspacePath) },
  get heldReadCount() { return heldReads.size },
  release() {
    probe.nextRead = 'ready'
    for (const resolve of heldReads) resolve()
    heldReads.clear()
  },
}
const unregister = registerGatewayCommandTransport(async (command, raw) => {
  if (command !== 'local_executor_request') throw new Error('Unsupported fixture command')
  const { method, params } = raw as { method: string; params: Record<string, unknown> }
  if (JSON.stringify(params.address) !== JSON.stringify(address)) throw new Error('Foreign task address')
  if (method === 'runtime.tasks.interactions.read') {
    probe.readCalls++
    const mode = probe.nextRead
    if (mode === 'fail') throw new Error('Original receipt unavailable')
    if (mode === 'hold') await new Promise<void>(resolve => { heldReads.add(resolve) })
    return structuredClone(snapshot)
  }
  if (method === 'runtime.tasks.interactions.respond') {
    probe.responses.push(structuredClone(params.response))
    snapshot.items[0].state = 'response_pending'
    return { reference: snapshot.items[0].reference, state: 'response_pending' }
  }
  throw new Error('Unsupported fixture method')
})
window.addEventListener('pagehide', unregister, { once: true })
Object.assign(window, { taskInteractionDraftProbe: probe })
await i18n.changeLanguage('en')
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
applyAppearance({ ...defaultAppearance, mode: theme }, theme)
const root = createRoot(document.getElementById('root')!)
function renderView(workspacePath = address.workspacePath) {
  root.render(
    <main className="min-h-screen bg-background p-6 text-text-primary">
      <TaskPendingInteractions address={{ ...address, workspacePath }} />
    </main>
  )
}
renderView()

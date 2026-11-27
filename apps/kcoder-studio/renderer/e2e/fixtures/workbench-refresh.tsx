import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchPaneContext } from '../../src/features/workbench/useWorkbench'
import { usePaneQueueDispatch } from '../../src/components/layout/pane/usePaneQueueDispatch'
import { useWorkbenchPaneEnvironment } from '../../src/components/layout/useWorkbenchPaneEnvironment'
import type { WorkbenchPaneContextValue } from '../../src/features/workbench/workbenchContextTypes'
import type { ProjectWorkControls } from '../../src/components/chat/ChatInput'
import type { RuntimeTaskAddress } from '../../src/types/api'

// Actual workbench hooks with controlled read callbacks; no target, model or credentials.
interface ReadCall { kind: 'queue' | 'environment'; deviceId: string; taskId?: string; force?: boolean }
const calls: ReadCall[] = []
const a = { deviceId: 'target-a', taskId: 'task-a', workspacePath: '/owned-a' }
const b = { deviceId: 'target-b', taskId: 'task-b', workspacePath: '/owned-b' }
const context = {
  state: { devices: [], projects: [], runtimeWork: null },
  loadEnvironmentInfo: async (_project: unknown, target: { deviceId: string; path: string }, options?: { force?: boolean }) => {
    calls.push({ kind: 'environment', deviceId: target.deviceId, force: options?.force === true })
    return { additions: '+0', deletions: '-0', executionTarget: 'local',
      deviceId: target.deviceId, workspacePath: target.path }
  },
} as unknown as WorkbenchPaneContextValue
const projectWork = {} as ProjectWorkControls
declare global {
  interface Window { __workbenchRefreshFixture: { calls: () => ReadCall[] } }
}
window.__workbenchRefreshFixture = { calls: () => calls.map(call => ({ ...call })) }

export function QueueReader({ address }: { address: RuntimeTaskAddress }) {
  const queue = useMemo(() => ({
    currentRuntimeTask: address,
    queuedMessages: [{ id: 'original-input', status: 'unknown', content: 'owned input' }],
    queuedMessagesPaused: false,
    paneStatus: { isBusy: true, canSendQueuedMessage: false },
    queuedMessageSendInFlightIdsRef: { current: new Set() },
    pendingAppliedGuidancesRef: { current: new Map() },
    refreshQueuedDelivery: async () => { calls.push({ kind: 'queue', deviceId: address.deviceId, taskId: address.taskId }) },
  }), [address])
  usePaneQueueDispatch(queue as unknown as Parameters<typeof usePaneQueueDispatch>[0])
  return <p>Unknown input on {address.deviceId}/{address.taskId}</p>
}

export function EnvironmentReader() {
  const [busy, setBusy] = useState(true)
  const environment = useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: a, currentProject: null }, projectWork, environmentRefreshActive: busy,
  })
  return <section>
    <output data-testid="environment-workspace">{environment.environmentInfo.workspacePath}</output>
    <button type="button" onClick={() => setBusy(false)}>Finish turn</button>
  </section>
}

const root = createRoot(document.getElementById('root')!)
root.render(<WorkbenchPaneContext.Provider value={context}>
  <main>
    <p>Controlled read callbacks; no backend or model.</p>
    <QueueReader address={a} /><QueueReader address={b} /><EnvironmentReader />
  </main>
</WorkbenchPaneContext.Provider>)
window.addEventListener('pagehide', () => root.unmount(), { once: true })

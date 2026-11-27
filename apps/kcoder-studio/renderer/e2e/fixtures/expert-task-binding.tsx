import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTaskExpert } from '../../src/features/experts/useTaskExpert'
import { registerGatewayCommandTransport } from '../../src/kcoder/gatewayServiceBridge'
import { requestTaskExpert } from '../../src/kcoder/gatewayTaskExpert'
import { notifyAccountContextChange } from '../../src/kcoder/accountContextEvents'
import type { GatewayRuntimeCore } from '../../src/kcoder/gateway/runtime/core'
import type { ThreadExpertResult } from '../../../shared/generated/contracts'

// Real hook, bridge and runtime adapter; only the final Gateway RPC is synthetic.
const bindingReads: number[] = []
let failBindingRead = false
let holdBindingRead = new URLSearchParams(location.search).has('hold')
let releaseBindingRead: (() => void) | undefined
let rpcCancellations = 0
const task = { taskId: 'fixture-task', threadId: 'fixture-thread', serverId: 'fixture-target', workspacePath: '/fixture' }
const client = {
  supportsExperimental: () => true,
  async request(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ThreadExpertResult> {
    if (method !== 'thread/expert' || params.change) throw new Error('The binding fixture only reads its synthetic task')
    bindingReads.push(performance.now())
    if (failBindingRead) {
      failBindingRead = false
      throw new Error('Fixture binding read failed')
    }
    const result: ThreadExpertResult = { threadId: task.threadId, revision: bindingReads.length, expert: null, turns: [] }
    if (!holdBindingRead) return result
    holdBindingRead = false
    return new Promise((resolve, reject) => {
      const abort = () => {
        rpcCancellations++
        releaseBindingRead = undefined
        reject(new DOMException('Aborted', 'AbortError'))
      }
      options?.signal?.addEventListener('abort', abort, { once: true })
      releaseBindingRead = () => {
        options?.signal?.removeEventListener('abort', abort)
        releaseBindingRead = undefined
        resolve(result)
      }
    })
  },
}
const core = {
  workspaceScanGeneration: 0, tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
  taskConnection: async () => ({ taskId: task.taskId, task, server: { id: task.serverId }, client }),
} as unknown as GatewayRuntimeCore
const unregister = registerGatewayCommandTransport((command, raw) => {
  const args = raw as { method?: string; params?: Record<string, unknown>; signal?: AbortSignal }
  if (command !== 'local_executor_request' || args.method !== 'runtime.taskExpert.request')
    throw new Error('Unexpected binding fixture command')
  return requestTaskExpert.call(core, args.params ?? {}, { signal: args.signal })
})
declare global {
  interface Window {
    __expertBindingFixture: {
      reads: () => number[]
      failNextRead: () => void
      holdNextRead: () => void
      release: () => void
      cancellations: () => number
      changeAccount: () => void
    }
  }
}
window.__expertBindingFixture = {
  reads: () => [...bindingReads],
  failNextRead: () => { failBindingRead = true },
  holdNextRead: () => { holdBindingRead = true },
  release: () => {
    if (!releaseBindingRead) throw new Error('No held binding read')
    releaseBindingRead()
  },
  cancellations: () => rpcCancellations,
  changeAccount: () => notifyAccountContextChange(task.serverId),
}

export function TaskBindingPreview({ name = 'single' }: { name?: string }) {
  const expert = useTaskExpert({
    deviceId: 'fixture-target', taskId: 'fixture-task', threadId: 'fixture-thread', workspacePath: '/fixture',
  })
  return <section data-testid={`binding-${name}`}>
    <output data-testid="binding-revision">{expert.snapshot?.revision}</output>
    <output data-testid="binding-error">{expert.error}</output>
    <button type="button" onClick={() => void expert.refresh().catch(() => {})}>Read again</button>
  </section>
}
export function TaskBindingFixture() {
  const [first, showFirst] = useState(true)
  const [second, showSecond] = useState(new URLSearchParams(location.search).get('readers') === '2')
  return <main>
    <p>Controlled Gateway RPC; no Native target, model or credentials.</p>
    {first && <TaskBindingPreview name="first" />}
    {second && <TaskBindingPreview name="second" />}
    <button type="button" onClick={() => showSecond(false)}>Close second view</button>
    <button type="button" onClick={() => { showFirst(false); showSecond(false) }}>Close all views</button>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<TaskBindingFixture />)
window.addEventListener('pagehide', () => { root.unmount(); unregister() }, { once: true })

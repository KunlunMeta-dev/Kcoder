import assert from 'node:assert/strict'

const SCENARIOS = new Set([
  'initial',
  'follow_up',
  'running_fork_follow_up',
  'fork_follow_up',
  'request_user_input',
  'window_lifecycle',
  'goal_idle',
  'goal_restart',
  'turn_navigation',
  'cancellation',
  'retry',
  'reconnect',
  'fresh_chat',
  'attachment_only',
  'pasted_zip_attachment',
  'pasted_workspace_paths',
  'dropped_workspace_paths',
  'memory',
  'concurrent_memory',
  'side_chat_attachment',
  'cloud_initial',
  'cloud_follow_up',
  'model_protocol_matrix',
  'provider_switch_retry',
])

export class DesktopModelScenarioState {
  constructor({ guard, localModels, timeoutMs, withTimeout }) {
    this.guard = guard
    this.timeoutMs = timeoutMs
    this.withTimeout = withTimeout
    this.scenario = 'initial'
    this.matrixCase = null
    this.matrixState = null
    this.requests = new Map()
    this.waiters = new Map()
    this.localProtocolStates = new Map(
      localModels.map(model => [model.protocol, { stage: 'initial', requests: [] }])
    )
  }

  setScenario(scenario) {
    assert.ok(SCENARIOS.has(scenario), `Unknown desktop E2E scenario: ${scenario}`)
    this.scenario = scenario
  }

  setMatrixCase(model) {
    this.matrixCase = model
    this.matrixState = { stage: 'text', requests: [] }
    this.setScenario('model_protocol_matrix')
  }

  recordRequest(scenario, request) {
    const requests = this.requests.get(scenario) ?? []
    requests.push(request)
    this.requests.set(scenario, requests)
    const waiter = this.waiters.get(scenario)
    if (waiter) {
      this.waiters.delete(scenario)
      waiter(request)
    }
  }

  awaitRequest(scenario) {
    const request = this.requests.get(scenario)?.at(-1)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolve => {
        this.waiters.set(scenario, resolve)
      })
    )
  }

  async awaitRequestCount(scenario, count) {
    const waitForCount = (async () => {
      while ((this.requests.get(scenario)?.length ?? 0) < count) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return this.requests.get(scenario).at(-1)
    })()
    return this.withTimeout(
      this.guard(waitForCount),
      this.timeoutMs,
      `Timed out waiting for ${count} ${scenario} scenario requests`
    )
  }
}

export function routeModelScenario(scenario, routes) {
  return routes[scenario]?.() ?? false
}

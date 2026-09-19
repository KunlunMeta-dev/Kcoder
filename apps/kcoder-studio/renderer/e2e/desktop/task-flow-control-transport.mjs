import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export class DesktopControlTransport {
  constructor({ guard, json, readRequestBody, timeoutMs, withTimeout }) {
    this.guard = guard
    this.json = json
    this.readRequestBody = readRequestBody
    this.timeoutMs = timeoutMs
    this.withTimeout = withTimeout
    this.ready = null
    this.readyResolver = null
    this.readyCount = 0
    this.activeClientId = null
    this.readyWaiters = []
    this.commandQueue = []
    this.commandResults = new Map()
    this.commandHistory = []
  }

  awaitReady() {
    if (this.ready) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolve => {
        this.readyResolver = resolve
      })
    )
  }

  awaitReadyAfter(readyCount) {
    if (this.readyCount > readyCount) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolve => {
        this.readyWaiters.push({ readyCount, resolve })
      })
    )
  }

  async command(action, selector, options = {}) {
    assert.ok(this.activeClientId, 'No active desktop control client is registered')
    const id = randomUUID()
    const command = { id, action, selector, ...options }
    const clientId = this.activeClientId
    const result = new Promise((resolve, reject) => {
      this.commandResults.set(id, { clientId, resolve, reject })
    })
    this.commandQueue.push({ clientId, command })
    return this.withTimeout(
      this.guard(result),
      options.timeoutMs ?? this.timeoutMs,
      `Timed out running UI action ${action} for ${selector}`
    )
  }

  fail(error) {
    for (const pending of this.commandResults.values()) pending.reject(error)
    this.commandResults.clear()
  }

  async handleRoute(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/ready') {
      const ready = await this.readRequestBody(request)
      assert.equal(typeof ready.clientId, 'string', 'Desktop control client ID is required')
      assert.ok(ready.clientId.length > 0, 'Desktop control client ID cannot be empty')
      const previousClientId = this.activeClientId
      this.activeClientId = ready.clientId
      if (previousClientId && previousClientId !== ready.clientId) {
        const replacementError = new Error(
          `Desktop control client ${previousClientId} was replaced by ${ready.clientId}`
        )
        this.commandQueue = this.commandQueue.filter(item => item.clientId !== previousClientId)
        for (const [id, pending] of this.commandResults) {
          if (pending.clientId !== previousClientId) continue
          this.commandResults.delete(id)
          pending.reject(replacementError)
        }
      }
      this.ready = ready
      this.readyCount += 1
      this.readyResolver?.(ready)
      this.readyResolver = null
      this.readyWaiters = this.readyWaiters.filter(waiter => {
        if (this.readyCount <= waiter.readyCount) return true
        waiter.resolve(ready)
        return false
      })
      this.json(response, 200, { ok: true })
      return true
    }

    if (request.method === 'GET' && url.pathname === '/commands') {
      const clientId = url.searchParams.get('clientId')
      if (!clientId || clientId !== this.activeClientId) {
        response.writeHead(204)
        response.end()
        return true
      }
      const commandIndex = this.commandQueue.findIndex(item => item.clientId === clientId)
      if (commandIndex >= 0) {
        const [{ command }] = this.commandQueue.splice(commandIndex, 1)
        this.commandHistory.push({
          ...command,
          clientId,
          deliveredAt: new Date().toISOString(),
        })
        this.json(response, 200, command)
        return true
      }
      response.writeHead(204)
      response.end()
      return true
    }

    if (request.method === 'GET' && url.pathname === '/control-tick') {
      setTimeout(() => {
        response.writeHead(204)
        response.end()
      }, 50)
      return true
    }

    if (request.method === 'POST' && url.pathname === '/results') {
      const result = await this.readRequestBody(request)
      const pending = this.commandResults.get(result.id)
      if (!pending) {
        this.json(response, 404, { error: `Unknown command ${result.id}` })
        return true
      }
      if (result.clientId !== pending.clientId || result.clientId !== this.activeClientId) {
        this.json(response, 409, {
          error: `Command ${result.id} belongs to a different desktop control client`,
        })
        return true
      }
      this.commandResults.delete(result.id)
      if (result.ok) {
        pending.resolve(result.value ?? '')
      } else {
        pending.reject(new Error(result.error ?? `UI action ${result.id} failed`))
      }
      this.json(response, 200, { ok: true })
      return true
    }
    return false
  }
}

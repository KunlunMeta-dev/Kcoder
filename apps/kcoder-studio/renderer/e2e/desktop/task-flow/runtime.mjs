// runtime for the existing desktop runner.
import { WORKBENCH_READY_TIMEOUT_MS } from './config.mjs'
import { withTimeout as commandWithTimeout, isExecutable } from '../task-flow-command.mjs'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export let commandOutput

export let runChecked

export let artifactSink

export let operationSignal

export const retainedLogRefreshers = new Map()

export function abortable(promise, signal = operationSignal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise)
      .then(resolvePromise, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
  })
}

export function withTimeout(promise, timeoutMs, message) {
  return abortable(commandWithTimeout(promise, timeoutMs, message))
}

export function delay(timeoutMs) {
  return abortable(
    new Promise(resolvePromise => {
      const timeout = setTimeout(resolvePromise, timeoutMs)
      operationSignal?.addEventListener('abort', () => clearTimeout(timeout), { once: true })
    })
  )
}

export async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
  await new Promise(resolvePromise => server.close(resolvePromise))
  return address.port
}

export async function waitForUrl(url, message, timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: operationSignal })
      if (response.ok) return
    } catch (error) {
      if (operationSignal?.aborted) throw operationSignal.reason ?? error
      // The real service is still starting.
    }
    await delay(250)
  }
  throw new Error(message)
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? operationSignal,
  })
  const body = await response.json()
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${url} failed: ${JSON.stringify(body)}`
  )
  return body
}

export async function resolveExecutable(configuredPath, fallbackCommand, description) {
  const candidate = configuredPath?.trim()
  if (candidate) {
    const absolutePath = resolve(candidate)
    assert.equal(
      await isExecutable(absolutePath),
      true,
      `${description} is not executable: ${absolutePath}`
    )
    return absolutePath
  }

  const resolved = await commandOutput('which', [fallbackCommand])
  assert.equal(await isExecutable(resolved), true, `${description} is not executable: ${resolved}`)
  return resolved
}

export async function writeRedactedJson(file, value) {
  await artifactSink.writeJson(file, value)
}

export function setArtifactSink(value) {
  artifactSink = value
}

export function setCommandOutput(value) {
  commandOutput = value
}

export function setRunChecked(value) {
  runChecked = value
}

export function setOperationSignal(value) {
  operationSignal = value
}

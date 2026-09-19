#!/usr/bin/env node

/**
 * Starts and controls an isolated KCoder Studio development application for AI verification.
 * The WebView performs the actions; this process only brokers authenticated loopback commands.
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const defaultTimeoutMs = 30_000
const startupTimeoutMs = 60_000
const commandResultGraceMs = 5_000
const corsHeaders = {
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-origin': '*',
}

function usage() {
  console.error(`Usage:
  pnpm --filter kcoder-studio-renderer ai:verify start
  pnpm --filter kcoder-studio-renderer ai:verify <capture|snapshot|click|close-to-tray|drag|drop-file|drop-paths|fill|hover|navigate|paste-paths|pointer-move|press|select-text|wait-for|text|status|stop> --session PATH [options]

Options:
  --gateway true            Verify current Gateway UI in an isolated Linux Tauri/Xvfb session
  --tauri-bin PATH          Explicit prebuilt debug Tauri binary (Gateway mode)
  --kcoder-bin PATH         Explicit real KCoder binary (Gateway mode)
  --renderer-root PATH      Current built renderer directory (Gateway mode)
  --expected-error TEXT     Require an action failure containing TEXT (Gateway mode)
  --codex-home-initialization true
                            Seed and verify isolated first-run Codex migration
  --selector CSS_SELECTOR   Target selector (required by click, fill, press and wait-for)
  --value TEXT              Replacement value for fill
  --target SELECTOR         Event target selector for pointer-move (default: body)
                            Required destination selector for drag
  --file PATH               File to dispatch for drop-file
  --value JSON              Path descriptors for paste-paths or drop-paths
  --key KEY                 Keyboard key for press
  --output PATH             PNG output path for capture
  --text TEXT               Expected text for wait-for
  --visible true            Require a visible element for wait-for
  --stable MS               Require the wait-for condition to remain stable
  --timeout MS              Command timeout (default: ${defaultTimeoutMs})`)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
    const key = value.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = next
    index += 1
  }
  return { command, options }
}

export function resolveStartupTimeout(timeout) {
  const configuredTimeout = timeout === undefined ? startupTimeoutMs : Number(timeout)
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    throw new Error('--timeout must be a finite positive number')
  }
  return configuredTimeout
}

export function resolveGatewaySessionFailure(ready, failure) {
  return failure ?? (ready ? null : new Error('Gateway WebView did not reach ready'))
}

export function applyGatewayShutdownFailure(failure, requestBody) {
  if (!failure && requestBody?.failure === 'verification-failed') {
    return new Error('Gateway business verification failed')
  }
  return (
    failure ??
    (requestBody?.failure === 'startup-timeout'
      ? new Error('Gateway verification startup timed out')
      : null)
  )
}

export async function finishUnpublishedGatewaySession(context, sessionPath, failure) {
  try {
    await context.finish('failed', null, failure)
  } finally {
    await writeFile(
      sessionPath,
      JSON.stringify({
        gateway: true,
        status: 'stopped',
        startupError: failure.message,
        verificationError: failure.message,
      }),
      { mode: 0o600 }
    )
  }
}

export function resolveGatewayActionOutcome(command, value, error) {
  if (command.expectedFailure === true) {
    if (typeof command.expectedError !== 'string' || !command.expectedError.trim()) {
      const failure = new Error('Expected-negative actions require a nonempty error substring')
      return { response: { ok: false, error: failure.message }, failure }
    }
    if (
      error &&
      command.expectedError &&
      !String(error.message ?? error).includes(command.expectedError)
    ) {
      return {
        response: { ok: false, error: 'Action failed with an unexpected error' },
        failure: error,
      }
    }
    if (error)
      return {
        response: {
          ok: true,
          value: { expectedFailure: true, error: String(error.message ?? error) },
        },
        failure: null,
      }
    error = new Error(`Expected ${command.action} to fail, but it succeeded`)
  }
  return error
    ? { response: { ok: false, error: String(error.message ?? error) }, failure: error }
    : { response: { ok: true, value }, failure: null }
}

async function waitForGatewaySessionStop(sessionPath) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    let closed
    try {
      closed = JSON.parse(await readFile(sessionPath, 'utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    if (closed?.status === 'stopped') {
      if (closed.cleanupError) throw new Error(closed.cleanupError)
      if (closed.verificationError) throw new Error(closed.verificationError)
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Timed out cleaning owned Gateway verification resources')
}

function json(response, status, value) {
  response.writeHead(status, {
    ...corsHeaders,
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.once('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.once('error', reject)
  })
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`
}

export function takeWritableCommandPoll(commandPolls) {
  let poll = commandPolls.shift()
  while (poll) {
    clearTimeout(poll.timer)
    if (!poll.closed && !poll.response.destroyed && !poll.response.writableEnded) return poll
    poll = commandPolls.shift()
  }
  return undefined
}

async function stopOwnedSessionProcesses(session) {
  if (!Number.isInteger(session.launcherPid)) return
  await signalProcessGroup(session.launcherPid, 'TERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  await signalProcessGroup(session.launcherPid, 'KILL')
}

function signalProcessGroup(processGroupId, signal) {
  return new Promise(resolvePromise => {
    execFile('/bin/kill', [`-${signal}`, `-${processGroupId}`], () => {
      // The process group may already have exited.
      resolvePromise()
    })
  })
}

async function runServer(sessionPath, token) {
  const session = JSON.parse(await readFile(sessionPath, 'utf8'))
  let gatewayContext = null
  let gatewayVerification = null
  let gatewayFailure = null
  let gatewayFinishPromise = null
  const gatewayDiagnostics = []
  const gatewayActions = []
  if (session.gateway) {
    const { resumeGatewayVerificationRun } = await import('../../e2e/harness/ai-verify-gateway.mjs')
    gatewayContext = await resumeGatewayVerificationRun(session.directory, token)
  }
  const queue = []
  const commandPolls = []
  const pending = new Map()
  let ready = null
  let app = null
  function actionResponse(response, command, value, error) {
    const outcome = resolveGatewayActionOutcome(command, value, error)
    if (gatewayContext) {
      gatewayFailure ??= outcome.failure
      if (gatewayActions.length < 200)
        gatewayActions.push({
          action: command.action,
          expectedFailure: command.expectedFailure === true,
          ok: outcome.response.ok,
        })
    }
    return json(response, outcome.response.ok ? 200 : 500, outcome.response)
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...corsHeaders,
        })
        return response.end()
      }
      if (!authorized(request, token)) return json(response, 401, { error: 'Unauthorized' })
      if (gatewayContext && request.method === 'POST' && url.pathname === '/diagnostic') {
        const diagnostic = await readBody(request)
        if (gatewayDiagnostics.length < 30)
          gatewayDiagnostics.push(gatewayContext.redactValue(diagnostic))
        return json(response, 200, { ok: true })
      }
      if (request.method === 'POST' && url.pathname === '/ready') {
        const registration = await readBody(request)
        if (
          session.gateway &&
          (!gatewayVerification ||
            new URL(registration.location).origin !== gatewayVerification.gatewayOrigin)
        ) {
          return json(response, 403, { error: 'Unowned Gateway renderer' })
        }
        if (
          session.gateway &&
          (registration.nativeAppCommandDenied !== true ||
            registration.nativePluginCommandDenied !== true)
        ) {
          return json(response, 403, { error: 'Gateway native isolation was not verified' })
        }
        if (gatewayContext && !ready)
          await gatewayContext.writeArtifactJson('native-boundary.json', registration)
        ready = registration
        return json(response, 200, { ok: true })
      }
      if (request.method === 'GET' && url.pathname === '/commands') {
        const command = queue.shift()
        if (command) return json(response, 200, command)

        const poll = { response, timer: undefined, closed: false }
        poll.timer = setTimeout(() => {
          const index = commandPolls.indexOf(poll)
          if (index >= 0) commandPolls.splice(index, 1)
          response.writeHead(204, corsHeaders)
          response.end()
        }, defaultTimeoutMs)
        commandPolls.push(poll)
        response.once('close', () => {
          poll.closed = true
          const index = commandPolls.indexOf(poll)
          if (index < 0) return
          commandPolls.splice(index, 1)
          clearTimeout(poll.timer)
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/control-tick') {
        response.writeHead(204, corsHeaders)
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/results') {
        const result = await readBody(request)
        const waiter = pending.get(result.id)
        if (!waiter) return json(response, 404, { error: `Unknown command ${result.id}` })
        pending.delete(result.id)
        result.ok
          ? waiter.resolve(result.value ?? '')
          : waiter.reject(new Error(result.error ?? 'WebView action failed'))
        return json(response, 200, { ok: true })
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return json(response, 200, {
          ready: Boolean(ready),
          readyInfo: ready,
          pid: app?.pid ?? null,
          queuedCommands: queue.length,
          commandPolls: commandPolls.length,
          pendingCommands: pending.size,
        })
      }
      if (request.method === 'POST' && url.pathname === '/command') {
        const command = await readBody(request)
        if (gatewayVerification && command.action === 'capture') {
          try {
            return actionResponse(
              response,
              command,
              await gatewayVerification.capture(command.selector),
              null
            )
          } catch (error) {
            return actionResponse(response, command, undefined, error)
          }
        }
        if (!ready) {
          if (!gatewayContext) return json(response, 409, { error: 'KCoder Studio WebView is not ready' })
          return actionResponse(
            response,
            command,
            undefined,
            new Error('KCoder Studio WebView is not ready')
          )
        }
        const id = randomUUID()
        const timeoutMs = Number(command.timeoutMs) || defaultTimeoutMs
        const result = new Promise((resolvePromise, reject) =>
          pending.set(id, { resolve: resolvePromise, reject })
        )
        const nextCommand = { id, ...command }
        const poll = takeWritableCommandPoll(commandPolls)
        if (poll) {
          json(poll.response, 200, nextCommand)
        } else {
          queue.push(nextCommand)
        }
        try {
          return actionResponse(
            response,
            command,
            await withTimeout(
              result,
              timeoutMs + commandResultGraceMs,
              `Timed out running ${command.action}`
            ),
            null
          )
        } catch (error) {
          pending.delete(id)
          return actionResponse(response, command, undefined, error)
        }
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        if (gatewayContext)
          gatewayFailure = applyGatewayShutdownFailure(gatewayFailure, await readBody(request))
        response.once('finish', () => {
          if (gatewayContext) {
            void finishGatewaySession().finally(() => {
              server.closeAllConnections()
              server.close(() => process.exit(0))
            })
            return
          }
          void stopOwnedSessionProcesses(updated).finally(() => server.close(() => process.exit(0)))
        })
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: 'Not found' })
    })().catch(error => json(response, 500, { error: String(error.message ?? error) }))
  })
  await new Promise((resolvePromise, reject) =>
    server.listen(0, '127.0.0.1', error => (error ? reject(error) : resolvePromise()))
  )
  const address = server.address()
  const controlUrl = `http://127.0.0.1:${address.port}`
  const updated = {
    ...session,
    controlUrl,
    status: 'starting',
  }
  await writeFile(sessionPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
  function finishGatewaySession() {
    gatewayFinishPromise ??= finishGatewaySessionOnce()
    return gatewayFinishPromise
  }
  async function finishGatewaySessionOnce() {
    gatewayFailure = resolveGatewaySessionFailure(ready, gatewayFailure)
    let cleanupFailure = null
    try {
      await gatewayContext.writeArtifactJson('startup-diagnostics.json', gatewayDiagnostics)
      await gatewayContext.writeArtifactJson('actions.json', gatewayActions)
    } catch (error) {
      gatewayFailure ??= error
    }
    try {
      await gatewayContext.finish(
        gatewayFailure ? 'failed' : 'passed',
        { sessionClosed: true },
        gatewayFailure
      )
    } catch (error) {
      const result = await readFile(join(session.directory, 'artifacts', 'result.json'), 'utf8')
        .then(value => JSON.parse(value))
        .catch(() => null)
      if (!result || result.cleanupErrors?.length || error !== gatewayFailure)
        cleanupFailure = error
      throw error
    } finally {
      await writeFile(
        sessionPath,
        `${JSON.stringify(
          {
            version: 1,
            directory: session.directory,
            gateway: true,
            status: 'stopped',
            ...(cleanupFailure
              ? { cleanupError: gatewayContext.redactText(cleanupFailure.message) }
              : {}),
            ...(gatewayFailure
              ? {
                  verificationError: gatewayContext.redactText(gatewayFailure.message),
                  ...(!ready
                    ? { startupError: gatewayContext.redactText(gatewayFailure.message) }
                    : {}),
                }
              : {}),
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      )
    }
  }
  if (gatewayContext) {
    const onSignal = () => {
      gatewayFailure ??= new Error('Verification controller was interrupted')
      void finishGatewaySession().finally(() => process.exit(1))
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    try {
      const { launchGatewayVerification } = await import('../../e2e/harness/ai-verify-gateway.mjs')
      gatewayVerification = await launchGatewayVerification(gatewayContext, session.gateway, {
        controlUrl,
        token,
      })
      app = gatewayVerification.app
      app.once('exit', () => {
        if (!gatewayContext.finishing && !gatewayContext.finished) {
          gatewayFailure ??= new Error('Owned Tauri process exited')
          void finishGatewaySession().finally(() => process.exit(1))
        }
      })
    } catch (error) {
      gatewayFailure ??= error
      try {
        await finishGatewaySession()
      } finally {
        server.closeAllConnections()
        server.close(() => process.exit(1))
      }
    }
    return
  }
  const log = join(session.directory, 'app.log')
  const executorHome = join(session.directory, 'executor-home')
  const codexHome = join(executorHome, 'codex')
  const nativeCodexHome = session.verifyCodexHomeInitialization
    ? join(session.directory, 'native-codex')
    : undefined
  await mkdir(codexHome, { recursive: true })
  if (nativeCodexHome) {
    await mkdir(nativeCodexHome, { recursive: true })
    await writeFile(join(nativeCodexHome, 'auth.json'), '{"test":"isolated-auth"}\n')
    await writeFile(join(nativeCodexHome, 'config.toml'), 'model = "gpt-5"\n')
  }
  app = spawn('bash', ['scripts/dev-mac-app.sh'], {
    cwd: weworkDir,
    detached: true,
    env: buildAiVerifyEnvironment(process.env, {
      controlUrl,
      token,
      codexHome,
      nativeCodexHome,
      verifyCodexHomeInitialization: session.verifyCodexHomeInitialization,
      deviceId: session.deviceId,
      appIdentifier: `dev.kcoder.studio.ai-verify.${session.deviceId.replaceAll('-', '')}`,
      executorHome,
      sessionDirectory: session.directory,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await writeFile(sessionPath, `${JSON.stringify({ ...updated, launcherPid: app.pid }, null, 2)}\n`)
  for (const stream of [app.stdout, app.stderr])
    stream?.on(
      'data',
      chunk => void import('node:fs/promises').then(({ appendFile }) => appendFile(log, chunk))
    )
  app.once('exit', code => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`KCoder Studio exited with code ${code ?? 'unknown'}`))
    pending.clear()
  })
}

async function request(session, token, path, method = 'GET', body) {
  const response = await fetch(`${session.controlUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...(session.gateway
      ? {
          signal: AbortSignal.timeout(
            path === '/command'
              ? (Number(body?.timeoutMs) || defaultTimeoutMs) + commandResultGraceMs + 5000
              : 20_000
          ),
        }
      : {}),
  })
  const value = await response.json()
  if (!response.ok || value.ok === false)
    throw new Error(value.error ?? `Request failed with ${response.status}`)
  return value
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'serve') {
    const session = JSON.parse(await readFile(options.session, 'utf8'))
    return runServer(options.session, session.token)
  }
  if (command === 'start') {
    const startupTimeout = resolveStartupTimeout(options.timeout)
    let gateway
    let gatewayRun
    if (options.gateway !== undefined) {
      if (options.gateway !== 'true') throw new Error('--gateway must be true when supplied')
      if (options['codex-home-initialization'])
        throw new Error('Codex initialization is not a Gateway operation')
      const harness = await import('../../e2e/harness/ai-verify-gateway.mjs')
      gateway = await harness.gatewayVerificationOptions(options)
      gatewayRun = await harness.createGatewayVerificationRun()
    }
    const directory =
      gatewayRun?.runRoot ??
      join(
        weworkDir,
        'test-results',
        'ai-verify',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
      )
    await mkdir(directory, { recursive: true })
    const token = randomBytes(32).toString('hex')
    const sessionPath = join(directory, 'session.json')
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          version: 1,
          deviceId: `ai-verify-${randomUUID()}`,
          directory,
          token,
          status: 'starting',
          verifyCodexHomeInitialization: options['codex-home-initialization'] === 'true',
          ...(gateway ? { gateway } : {}),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'serve', '--session', sessionPath],
      {
        detached: true,
        stdio: 'ignore',
        ...(gatewayRun ? { env: gatewayRun.isolatedEnvironment() } : {}),
      }
    )
    child.unref()
    const startupDeadline = Date.now() + startupTimeout
    while (Date.now() < startupDeadline) {
      let session
      try {
        session = JSON.parse(await readFile(sessionPath, 'utf8'))
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
        continue
      }
      if (session.startupError) throw new Error(session.startupError)
      if (session.controlUrl) {
        try {
          const status = await request(session, token, '/status')
          if (status.ready && (!gatewayRun || Date.now() < startupDeadline)) {
            console.log(
              JSON.stringify(
                {
                  session: sessionPath,
                  controlUrl: session.controlUrl,
                  ...(gatewayRun ? { artifacts: gatewayRun.artifactsDir } : {}),
                },
                null,
                2
              )
            )
            return
          }
        } catch {
          // The controller can be briefly unavailable while its process starts.
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    const timedOutSession = JSON.parse(await readFile(sessionPath, 'utf8'))
    if (timedOutSession.controlUrl) {
      await request(
        timedOutSession,
        token,
        '/shutdown',
        'POST',
        gatewayRun ? { failure: 'startup-timeout' } : undefined
      )
      if (gatewayRun) await waitForGatewaySessionStop(sessionPath)
    } else if (gatewayRun) {
      await signalProcessGroup(child.pid, 'TERM')
      await signalProcessGroup(child.pid, 'KILL')
      const failure = new Error('Gateway verification controller startup timed out')
      await finishUnpublishedGatewaySession(gatewayRun, sessionPath, failure)
    }
    throw new Error('Timed out waiting for the KCoder Studio WebView to connect to AI verification')
  }
  if (!options.session) throw new Error('--session is required')
  const session = JSON.parse(await readFile(options.session, 'utf8'))
  if (command === 'stop') {
    if (session.gateway && session.status === 'stopped') {
      if (session.cleanupError) throw new Error(session.cleanupError)
      if (session.verificationError) throw new Error(session.verificationError)
      return
    }
    await request(session, session.token, '/shutdown', 'POST')
    if (session.gateway) {
      return waitForGatewaySessionStop(options.session)
    }
    await stopOwnedSessionProcesses(session)
    await rm(join(session.directory, 'executor-home', 'codex', 'auth.json'), { force: true })
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify(await request(session, session.token, '/status'), null, 2))
    return
  }
  const action = {
    capture: 'capture',
    snapshot: 'snapshot',
    click: 'click',
    'close-to-tray': 'closeMainWindowToTray',
    drag: 'drag',
    'drop-file': 'dropFile',
    'drop-paths': 'dropPaths',
    fill: 'fill',
    hover: 'hover',
    navigate: 'navigate',
    'paste-paths': 'pastePaths',
    'pointer-move': 'pointerMove',
    press: 'press',
    'select-text': 'selectText',
    'wait-for': 'waitFor',
    text: 'getText',
  }[command]
  if (!action) {
    usage()
    process.exitCode = 2
    return
  }
  const selector =
    options.selector ??
    (command === 'capture' ||
    command === 'snapshot' ||
    command === 'navigate' ||
    command === 'text' ||
    command === 'pointer-move' ||
    command === 'close-to-tray'
      ? 'body'
      : null)
  if (!selector) throw new Error('--selector is required')
  if (
    options['expected-error'] !== undefined &&
    (!session.gateway || !options['expected-error'].trim())
  ) {
    throw new Error('--expected-error TEXT is only supported in Gateway verification')
  }
  const dropFilePath = command === 'drop-file' ? options.file : undefined
  if (command === 'drop-file' && !dropFilePath) throw new Error('--file is required')
  const dropFileExtension = dropFilePath ? extname(dropFilePath).toLowerCase() : ''
  const dropFileMimeType =
    dropFileExtension === '.png'
      ? 'image/png'
      : dropFileExtension === '.jpg' || dropFileExtension === '.jpeg'
        ? 'image/jpeg'
        : dropFileExtension === '.txt'
          ? 'text/plain'
          : 'application/octet-stream'
  const value = await request(session, session.token, '/command', 'POST', {
    action,
    ...(session.gateway
      ? {
          expectedFailure: options['expected-error'] !== undefined,
          expectedError: options['expected-error'],
        }
      : {}),
    selector,
    target: options.target,
    value: dropFilePath ? (await readFile(dropFilePath)).toString('base64') : options.value,
    filename: dropFilePath ? basename(dropFilePath) : undefined,
    mimeType: dropFilePath ? dropFileMimeType : undefined,
    key: options.key,
    text: options.text,
    visible: options.visible === 'true',
    stableMs: options.stable ? Number(options.stable) : undefined,
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
  })
  if (command === 'capture') {
    if (options['expected-error'] !== undefined) {
      console.log(JSON.stringify(value.value))
      return
    }
    if (!options.output) throw new Error('--output is required')
    const prefix = 'data:image/png;base64,'
    if (!value.value?.startsWith(prefix)) throw new Error('Invalid screenshot payload')
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, Buffer.from(value.value.slice(prefix.length), 'base64'))
    console.log(outputPath)
    return
  }
  console.log(typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`ai:verify: ${error.message ?? error}`)
    process.exitCode = 1
  })
}

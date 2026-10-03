import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  processTreeAlive,
  processTreeIdentity,
  signalProcessTree,
  spawnWindowsSupervised,
} from '../../../e2e/harness/owned-process.mjs'
import { enforceRetention } from '../../../e2e/harness/retention.mjs'
import {
  createRedactingStream,
  isolatedEnvironment,
  redact,
} from '../../../e2e/harness/run-context.mjs'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repoRoot = resolve(packageRoot, '../../..')
const sourceRoot = resolve(
  repoRoot,
  'target/test/apps/kcoder-studio/renderer/e2e/harness/run-playwright.mjs'
)
const artifactBoundary = resolve(repoRoot, 'target/test/apps/kcoder-studio/renderer/e2e')
const READY_TIMEOUT_MS = 120_000

export class OwnedPlaywrightRun {
  static async create(options = {}) {
    await enforceRetention(artifactBoundary)
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .replace('Z', 'Z')
    const runRoot = resolve(
      sourceRoot,
      `${timestamp}-p${process.pid}-${randomBytes(4).toString('hex')}`
    )
    const run = new OwnedPlaywrightRun(runRoot, options)
    await Promise.all([
      mkdir(run.logsDir, { recursive: true }),
      mkdir(run.artifactsDir, { recursive: true }),
      mkdir(run.stateDir, { recursive: true, mode: 0o700 }),
    ])
    await run.writeManifest('running')
    return run
  }

  constructor(runRoot, options = {}) {
    this.runRoot = runRoot
    this.logsDir = resolve(runRoot, 'logs')
    this.artifactsDir = resolve(runRoot, 'artifacts')
    this.stateDir = resolve(runRoot, 'state')
    this.processes = []
    this.services = {}
    this.cleanupSteps = []
    this.startedAt = new Date()
    this.seed = randomBytes(8).toString('hex')
    this.gitCommit = gitCommit()
    this.playwrightSummary = null
    this.secrets = new Set()
    this.finished = false
    this.finishing = false
    this.finishPromise = null
    this.manifestWrite = Promise.resolve()
    this.stopRecordOptions = options.stopRecordOptions ?? {}
  }

  async startServices() {
    const definitions = [
      ['responses', 'e2e/utils/mock-response-api-server.mjs', 'KCODER_STUDIO_RESPONSE_API_MOCK_PORT'],
      ['sites', 'e2e/utils/mock-sites-upstream-server.mjs', 'KCODER_STUDIO_SITES_UPSTREAM_MOCK_PORT'],
      [
        'connector',
        'e2e/utils/mock-connector-upstream-server.mjs',
        'KCODER_STUDIO_CONNECTOR_UPSTREAM_MOCK_PORT',
      ],
    ]
    const ready = await Promise.all(
      definitions.map(([label, script, variable]) =>
        this.spawnReady(
          label,
          process.execPath,
          [resolve(packageRoot, script)],
          this.childEnvironment({
            [variable]: '0',
          })
        )
      )
    )
    for (const item of ready) this.services[item.service] = item

    const serviceUrls = this.serviceUrls()
    const vite = await this.spawnReady(
      'vite',
      process.execPath,
      [resolve(packageRoot, 'e2e/harness/vite-server.mjs')],
      this.childEnvironment({
        VITE_KCODER_STUDIO_E2E: 'true',
        VITE_KCODER_STUDIO_RUNTIME_MODE: 'backend',
        VITE_LOGIN_MODE: 'password',
        KCODER_STUDIO_E2E_VITE_PUBLIC_DIR: resolve(this.stateDir, 'vite-public'),
        KCODER_STUDIO_RESPONSE_API_MOCK_URL: serviceUrls.responses,
        KCODER_STUDIO_SITES_UPSTREAM_MOCK_URL: serviceUrls.sites,
        KCODER_STUDIO_CONNECTOR_UPSTREAM_MOCK_URL: serviceUrls.connector,
      })
    )
    this.services.vite = vite
    await this.writeManifest('running')
    return this.serviceUrls()
  }

  serviceUrls() {
    return Object.fromEntries(
      Object.entries(this.services).map(([name, ready]) => [name, `http://127.0.0.1:${ready.port}`])
    )
  }

  async runPlaywright(args) {
    const urls = this.serviceUrls()
    for (const name of ['responses', 'sites', 'connector', 'vite']) {
      if (!urls[name]) throw new Error(`owned ${name} URL is unavailable`)
    }
    const cli = resolve(packageRoot, 'node_modules/@playwright/test/cli.js')
    const record = this.spawnOwned(
      'playwright',
      process.execPath,
      [cli, ...args],
      this.childEnvironment(
        {
          KCODER_STUDIO_E2E_BASE_URL: urls.vite,
          KCODER_STUDIO_RESPONSE_API_MOCK_URL: urls.responses,
          KCODER_STUDIO_SITES_UPSTREAM_MOCK_URL: urls.sites,
          KCODER_STUDIO_CONNECTOR_UPSTREAM_MOCK_URL: urls.connector,
          KCODER_STUDIO_E2E_ARTIFACTS_ROOT: this.artifactsDir,
        },
        ['PLAYWRIGHT_BROWSERS_PATH']
      )
    )
    const { code, signal } = await waitForExit(record.child)
    this.playwrightSummary = await readPlaywrightSummary(
      resolve(this.artifactsDir, 'playwright-results.json')
    )
    if (code !== 0) throw new Error(`Playwright exited with ${code ?? signal ?? 'unknown status'}`)
    const listOnly = args.includes('--list')
    if (!args.includes('--ui') && !validSuccessfulSummary(this.playwrightSummary, { listOnly })) {
      throw new Error('Playwright exited successfully without a valid passing JSON report')
    }
  }

  childEnvironment(overrides, passNames = []) {
    return isolatedEnvironment(overrides, passNames, {
      HOME: resolve(this.stateDir, 'home'),
      USERPROFILE: resolve(this.stateDir, 'home'),
    })
  }

  registerSecret(value) {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value)
  }

  spawnOwned(label, command, args, env) {
    if (this.finishing || this.finished) throw new Error('owned E2E run is cleaning or finished')
    const log = createWriteStream(resolve(this.logsDir, `${label}.log`), {
      flags: 'a',
      mode: 0o600,
    })
    const options = {
      cwd: packageRoot,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const supervised =
      process.platform === 'win32'
        ? spawnWindowsSupervised(command, args, options, resolve(this.stateDir, label))
        : null
    const child = supervised?.child ?? spawn(command, args, options)
    const identity = supervised?.identity ?? processTreeIdentity(child)
    const outputWorkers = [child.stdout, child.stderr].filter(Boolean).map(source => {
      const redactor = createRedactingStream(
        value => redact(value, '', this.secrets),
        () => this.secrets
      )
      return createLogWorker(source, redactor, log)
    })
    const record = {
      label,
      child,
      identity,
      log,
      drains: outputWorkers.map(worker => worker.completion),
      outputWorkers,
      command,
      args: [...args],
      environmentSelectors: Object.keys(env).sort(),
      pid: identity.pid,
      pgid: identity.pgid,
    }
    this.processes.push(record)
    void this.writeManifest('running')
    return record
  }

  async spawnReady(label, command, args, env) {
    const record = this.spawnOwned(label, command, args, env)
    const ready = await readReady(record.child, label)
    if (ready.service !== label || ready.host !== '127.0.0.1' || !Number.isInteger(ready.port)) {
      throw new Error(`${label} emitted an invalid READY record`)
    }
    return ready
  }

  async finish(status, error = null) {
    if (this.finished) return
    if (this.finishPromise) return this.finishPromise
    this.finishing = true
    this.finishPromise = this.finishInternal(status, error)
    return this.finishPromise
  }

  async finishInternal(status, error) {
    const cleanupErrors = []
    for (const record of [...this.processes].reverse()) {
      try {
        await stopRecord(record, this.stopRecordOptions)
        this.cleanupSteps.push({ label: record.label, status: 'completed' })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
        this.cleanupSteps.push({
          label: record.label,
          status: 'failed',
          error: redact(cleanupError.message, '', this.secrets),
        })
      }
    }
    await rm(this.stateDir, { recursive: true, force: true })
    this.cleanupSteps.push({ label: 'remove run state', status: 'completed' })
    const finalError = error ?? cleanupErrors[0] ?? null
    const result = redact(
      {
        status: finalError ? 'failed' : status,
        error: finalError?.message ?? null,
        playwright: this.playwrightSummary,
      },
      '',
      this.secrets
    )
    await writeFile(
      resolve(this.artifactsDir, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 }
    )
    await this.writeManifest(finalError ? 'failed' : status, finalError)
    await enforceRetention(artifactBoundary)
    this.finished = true
    this.finishing = false
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owned E2E cleanup failed')
  }

  async writeManifest(status, error = null) {
    const manifest = {
      source: 'apps/kcoder-studio/renderer/e2e/harness/run-playwright.mjs',
      status,
      startedAt: this.startedAt.toISOString(),
      endedAt: status === 'running' ? null : new Date().toISOString(),
      gitCommit: this.gitCommit,
      seed: this.seed,
      runRoot: this.runRoot,
      ports: Object.entries(this.services).map(([label, item]) => ({ label, port: item.port })),
      processes: this.processes.map(item => ({
        label: item.label,
        command: item.command,
        argv: item.args,
        environmentSelectors: item.environmentSelectors,
        pid: item.pid,
        pgid: item.pgid,
      })),
      cleanupSteps: this.cleanupSteps,
      playwright: this.playwrightSummary,
      error: error ? redact(error.message, '', this.secrets) : null,
    }
    this.manifestWrite = this.manifestWrite.then(() =>
      writeFile(
        resolve(this.runRoot, 'manifest.json'),
        `${JSON.stringify(redact(manifest, '', this.secrets), null, 2)}\n`,
        {
          mode: 0o600,
        }
      )
    )
    await this.manifestWrite
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

async function readPlaywrightSummary(path) {
  try {
    const report = JSON.parse(await readFile(path, 'utf8'))
    const stats = report.stats ?? {}
    const passed = stats.expected
    const failed = stats.unexpected
    const skipped = stats.skipped
    const flaky = stats.flaky
    if (![passed, failed, skipped, flaky].every(Number.isSafeInteger)) return null
    return { total: passed + failed + skipped + flaky, passed, failed, skipped, flaky }
  } catch {
    return null
  }
}

export function validSuccessfulSummary(summary, { listOnly = false } = {}) {
  if (!summary) return false
  const counts = [summary.total, summary.passed, summary.failed, summary.skipped, summary.flaky]
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)) {
    return false
  }
  if (summary.total !== summary.passed + summary.failed + summary.skipped + summary.flaky) {
    return false
  }
  if (summary.total === 0) return false
  if (listOnly) return true
  return summary.failed === 0 && summary.passed + summary.flaky > 0
}

export function createLogWorker(source, redactor, destination) {
  const completion = pipeline(source, redactor, destination, { end: false })
  // Install rejection handlers immediately so no unhandled rejection appears between process exit and final cleanup.
  void completion.catch(() => {})
  return { source, redactor, destination, completion }
}

async function readReady(child, label) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => finish(reject, new Error(`${label} READY timed out`)),
      READY_TIMEOUT_MS
    )
    const finish = (callback, value) => {
      clearTimeout(timer)
      callback(value)
    }
    let pending = ''
    child.stdout?.on('data', chunk => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const value = JSON.parse(line)
          if (value.event === 'READY') finish(resolveReady, value)
        } catch {
          // Non-protocol logs are already recorded for this run and do not count as READY.
        }
      }
    })
    child.once('error', error => finish(reject, error))
    child.once('exit', (code, signal) =>
      finish(reject, new Error(`${label} exited before READY (${code ?? signal ?? 'unknown'})`))
    )
  })
}

export async function stopRecord(
  record,
  { drainTimeoutMs = 5_000, logCloseTimeoutMs = 1_000 } = {}
) {
  const cleanupErrors = []
  try {
    if (await processTreeAlive(record.child, record.identity)) {
      await signalProcessTree(record.child, record.identity, 'SIGTERM')
      await waitUntilStopped(record, 5_000).catch(async () => {
        await signalProcessTree(record.child, record.identity, 'SIGKILL')
        await waitUntilStopped(record, 5_000)
      })
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await withTimeout(Promise.all(record.drains), drainTimeoutMs, `${record.label} output drain`)
  } catch (error) {
    cleanupErrors.push(error)
  } finally {
    try {
      await closeRecordOutput(record, logCloseTimeoutMs)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length) {
    const detail = cleanupErrors.map(error => error.message).join('; ')
    throw new AggregateError(
      cleanupErrors,
      `${record.label} output cleanup failed${detail ? `: ${detail}` : ''}`
    )
  }
}

async function closeRecordOutput(record, timeoutMs) {
  for (const worker of record.outputWorkers ?? []) {
    worker.source.unpipe(worker.redactor)
    worker.redactor.unpipe(worker.destination)
    if (!worker.source.destroyed) worker.source.destroy()
    if (!worker.redactor.destroyed) worker.redactor.destroy()
  }

  const log = record.log
  if (log.closed || log.destroyed) return
  const closed = new Promise((resolveClose, rejectClose) => {
    log.once('close', resolveClose)
    log.once('error', rejectClose)
  })
  try {
    if (!log.writableEnded) log.end()
    await withTimeout(closed, timeoutMs, `${record.label} log close`)
  } finally {
    if (!log.destroyed) log.destroy()
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function waitUntilStopped(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await processTreeAlive(record.child, record.identity))) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`${record.label} process tree survived cleanup`)
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

export async function runOwnedPlaywright(args, options = {}) {
  const run = await OwnedPlaywrightRun.create()
  let failure = null
  let rejectSignal
  const signalTarget = options.signalTarget ?? process
  const interrupted = new Promise((_, reject) => {
    rejectSignal = reject
  })
  const onSignal = signal => rejectSignal(new Error(`owned E2E runner received ${signal}`))
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  signalTarget.once('SIGINT', onSigint)
  signalTarget.once('SIGTERM', onSigterm)
  try {
    await Promise.race([
      (async () => {
        const urls = await run.startServices()
        await options.onServicesReady?.(run, urls)
        if (options.holdAfterReady) await new Promise(() => {})
        else await run.runPlaywright(args)
      })(),
      interrupted,
    ])
  } catch (error) {
    failure = error
  }
  try {
    await run.finish(failure ? 'failed' : 'passed', failure)
  } catch (cleanupError) {
    failure ??= cleanupError
  }
  signalTarget.removeListener('SIGINT', onSigint)
  signalTarget.removeListener('SIGTERM', onSigterm)
  if (failure) {
    console.error(run.runRoot)
    throw failure
  }
  return run
}

async function main() {
  let run
  try {
    run = await runOwnedPlaywright(process.argv.slice(2))
  } finally {
    if (run) console.log(run.runRoot)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

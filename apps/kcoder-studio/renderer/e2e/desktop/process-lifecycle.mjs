import { spawn as nodeSpawn } from 'node:child_process'
import { createReadStream as nodeCreateReadStream } from 'node:fs'
import {
  access as nodeAccess,
  appendFile as nodeAppendFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_GROUP_GRACE_PERIOD_MS = 1_000
const PROCESS_GROUP_POLL_INTERVAL_MS = 25
const CLEANUP_TIMEOUT_MS = 15_000
const LOG_DRAIN_TIMEOUT_MS = 5_000
const LOG_BUFFER_MAX_CHARS = 4_096
const REDACTED = '[REDACTED]'

const PROCESS_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'AR',
  'CARGO_HOME',
  'CARGO_TARGET_DIR',
  'CC',
  'CODEX_BIN',
  'CODEX_BINARY_PATH',
  'CODEX_HOME',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'DYLD_LIBRARY_PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  'LIBRARY_PATH',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'PKG_CONFIG_PATH',
  'PYTHONPATH',
  'RUSTC_WRAPPER',
  'RUSTFLAGS',
  'RUSTUP_HOME',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'UV_CACHE_DIR',
  'VIRTUAL_ENV',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'CXX',
])

const PROCESS_ENV_PROFILES = {
  redis: new Set([
    'COMSPEC',
    'HOME',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
  ]),
  backend: new Set([
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PYTHONPATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'UV_CACHE_DIR',
    'VIRTUAL_ENV',
  ]),
  build: PROCESS_ENV_ALLOWLIST,
  runtime: PROCESS_ENV_ALLOWLIST,
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs)) return promise
  if (timeoutMs <= 0) return Promise.reject(new Error(message))
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

export function createMinimalProcessEnv(sourceEnv = {}, overrides = {}) {
  return createProcessEnvironment('runtime', sourceEnv, overrides)
}

export function createProcessEnvironment(profile, sourceEnv = {}, overrides = {}) {
  const allowlist = PROCESS_ENV_PROFILES[profile]
  if (!allowlist) throw new Error(`Unknown process environment profile: ${profile}`)
  const env = {}
  for (const name of allowlist) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[name]
    else env[name] = String(value)
  }
  return env
}

export function redactSensitiveData(value, secrets = []) {
  if (typeof value === 'string') return redactSensitiveText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactSensitiveData(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api[_-]?key|token|password|secret/i.test(key)
        ? REDACTED
        : redactSensitiveData(item, secrets),
    ])
  )
}

export function redactSensitiveText(value, secrets = []) {
  let text = String(value)
  const uniqueSecrets = [...new Set(secrets.filter(Boolean).map(String))].sort(
    (left, right) => right.length - left.length
  )
  for (const secret of uniqueSecrets) text = text.split(secret).join(REDACTED)
  return text
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      `$1${REDACTED}`
    )
}

export function createArtifactSink({ writeFile = nodeWriteFile, secrets = [] } = {}) {
  const currentSecrets = () => (typeof secrets === 'function' ? secrets() : secrets)
  return {
    writeJson(file, value) {
      return writeFile(
        file,
        `${JSON.stringify(redactSensitiveData(value, currentSecrets()), null, 2)}\n`,
        'utf8'
      )
    },
    writeText(file, value) {
      return writeFile(file, redactSensitiveText(value, currentSecrets()), 'utf8')
    },
  }
}

export function assertDesktopProcessIsolationSupported(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error(
      'Desktop E2E requires atomic descendant process containment; Windows Job Object support is not implemented'
    )
  }
}

export function createProcessLogPipeline({
  destination,
  secrets = [],
  appendFile = nodeAppendFile,
  drainTimeoutMs = LOG_DRAIN_TIMEOUT_MS,
  maxBufferedChars = LOG_BUFFER_MAX_CHARS,
  now = Date.now,
}) {
  const readers = new Set()
  const streams = new Set()
  const abortController = new AbortController()
  const currentSecrets = () => {
    const values = typeof secrets === 'function' ? secrets() : secrets
    return [...new Set(values.filter(Boolean).map(String))].sort(
      (left, right) => right.length - left.length
    )
  }
  let sinkQueue = Promise.resolve()
  let sinkError = null
  let closed = false

  const write = value => {
    if (!value || closed) return sinkQueue
    const redacted = redactSensitiveText(value, currentSecrets())
    sinkQueue = sinkQueue.then(() =>
      appendFile(destination, redacted, { signal: abortController.signal })
    )
    sinkQueue.catch(error => {
      sinkError ??= error
    })
    return sinkQueue
  }

  const safeFlushLength = (buffer, desired) => {
    const normalizedSecrets = currentSecrets()
    let retainedPrefixLength = 0
    for (const secret of normalizedSecrets) {
      const limit = Math.min(secret.length - 1, buffer.length)
      for (let length = limit; length > retainedPrefixLength; length -= 1) {
        if (buffer.endsWith(secret.slice(0, length))) {
          retainedPrefixLength = length
          break
        }
      }
    }
    let flushLength = Math.min(Math.max(0, desired), buffer.length - retainedPrefixLength)
    for (const secret of normalizedSecrets) {
      let offset = buffer.indexOf(secret)
      while (offset >= 0) {
        const end = offset + secret.length
        if (offset < flushLength && end > flushLength) flushLength = offset
        offset = buffer.indexOf(secret, offset + 1)
      }
    }
    return flushLength
  }

  const attach = (stream, { retainTrailingSecretPrefix = false } = {}) => {
    if (!stream || closed) return Promise.resolve()
    streams.add(stream)
    const reader = (async () => {
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      for await (const chunk of stream) {
        if (closed) break
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const newlineFlush = buffer.lastIndexOf('\n') + 1
        const boundedFlushCandidate =
          buffer.length > maxBufferedChars
            ? buffer.length - Math.max(1, Math.floor(maxBufferedChars / 2))
            : 0
        const flushLength = safeFlushLength(buffer, Math.max(newlineFlush, boundedFlushCandidate))
        if (flushLength > 0) {
          await write(buffer.slice(0, flushLength))
          buffer = buffer.slice(flushLength)
        }
      }
      if (!closed) {
        buffer += decoder.end()
        const flushLength = retainTrailingSecretPrefix
          ? safeFlushLength(buffer, buffer.length)
          : buffer.length
        await write(buffer.slice(0, flushLength))
      }
    })()
    readers.add(reader)
    reader
      .catch(error => {
        sinkError ??= error
      })
      .finally(() => streams.delete(stream))
    return reader
  }

  const drain = async ({ deadlineAt = now() + drainTimeoutMs } = {}) => {
    const timeoutMs = Math.max(0, Math.min(drainTimeoutMs, deadlineAt - now()))
    try {
      await withTimeout(
        Promise.allSettled([...readers]).then(async results => {
          await sinkQueue
          const readerFailure = results.find(result => result.status === 'rejected')
          if (readerFailure) throw readerFailure.reason
          if (sinkError) throw sinkError
        }),
        timeoutMs,
        `Timed out draining process log ${destination}`
      )
      closed = true
    } catch (error) {
      closed = true
      abortController.abort()
      for (const stream of streams) stream.destroy?.()
      throw error
    }
  }

  return { attach, drain }
}

export function createRedactedLogRetainer({
  source,
  destination,
  secrets = [],
  createReadStream = nodeCreateReadStream,
  access = nodeAccess,
  remove = nodeRm,
  rename = nodeRename,
  readChunkBytes = 64,
  ...pipelineOptions
}) {
  let syncQueue = Promise.resolve()
  let sequence = 0
  const syncOnce = async ({ final = false } = {}) => {
    try {
      await access(source)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    sequence += 1
    const staging = `${destination}.redacting-${process.pid}-${sequence}`
    await remove(staging, { force: true })
    const pipeline = createProcessLogPipeline({
      destination: staging,
      secrets,
      ...pipelineOptions,
    })
    try {
      const stream = createReadStream(source, { highWaterMark: readChunkBytes })
      void pipeline.attach(stream, { retainTrailingSecretPrefix: !final })
      await pipeline.drain()
      await rename(staging, destination)
      return true
    } finally {
      await remove(staging, { force: true })
      if (final) await remove(source, { force: true })
    }
  }
  return {
    sync(options) {
      const result = syncQueue.then(() => syncOnce(options))
      syncQueue = result.catch(() => {})
      return result
    },
  }
}

export function combinePrimaryAndCleanupErrors(primaryError, cleanupError) {
  if (!primaryError) return cleanupError
  if (!cleanupError) return primaryError
  return new AggregateError(
    [primaryError, cleanupError],
    'Desktop E2E failed and cleanup also failed',
    { cause: primaryError }
  )
}

export function createResourceOwner({
  processRef = process,
  spawn = nodeSpawn,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  deadlineAt = Number.POSITIVE_INFINITY,
  now = Date.now,
  stopGroup = stopProcessGroup,
  stopSingle = stopProcess,
} = {}) {
  const cleanups = []
  const logPipelines = []
  const signalHandlers = new Map()
  const processRegistrations = new WeakMap()
  const processExits = new WeakMap()
  let cleanupPromise = null
  let signalTriggered = false
  const operationAbortController = new AbortController()

  const createdAt = now()
  const cleanupReserveMs = Number.isFinite(deadlineAt)
    ? Math.min(cleanupTimeoutMs, Math.max(0, deadlineAt - createdAt) / 2)
    : cleanupTimeoutMs
  const operationDeadlineAt = Number.isFinite(deadlineAt)
    ? deadlineAt - cleanupReserveMs
    : Number.POSITIVE_INFINITY
  const remainingUntil = target => Math.max(0, target - now())
  const cleanupDeadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : createdAt + cleanupTimeoutMs

  const runOperation = async operation => {
    const timeoutMs = remainingUntil(operationDeadlineAt)
    if (!Number.isFinite(timeoutMs)) return operation(operationAbortController.signal)
    if (timeoutMs <= 0) {
      operationAbortController.abort(new Error('Desktop E2E operation deadline reached'))
      throw operationAbortController.signal.reason
    }
    let timeout
    const deadlinePromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Desktop E2E operation deadline reached; starting cleanup reserve')
        operationAbortController.abort(error)
        reject(error)
      }, timeoutMs)
    })
    const operationPromise = Promise.resolve().then(() =>
      operation(operationAbortController.signal)
    )
    void operationPromise.catch(() => {})
    try {
      return await Promise.race([operationPromise, deadlinePromise])
    } finally {
      clearTimeout(timeout)
    }
  }

  const register = (name, cleanup) => {
    const entry = { name, cleanup, active: true }
    cleanups.push(entry)
    return () => {
      entry.active = false
    }
  }

  const captureProcessOutput = (stream, destination, options = {}) => {
    let pipeline = logPipelines.find(item => item.destination === destination)
    if (!pipeline) {
      pipeline = {
        destination,
        value: createProcessLogPipeline({ destination, now, ...options }),
      }
      logPipelines.push(pipeline)
    }
    void pipeline.value.attach(stream)
    return pipeline.value
  }

  const spawnProcess = async (command, args = [], options = {}) => {
    const {
      resourceName = `${command} process group`,
      cleanup = 'group',
      ...spawnOptions
    } = options
    let child
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        detached: spawnOptions.detached ?? processRef.platform !== 'win32',
      })
    } catch (error) {
      throw new Error(`Failed to spawn ${command}`, { cause: error })
    }
    const exitPromise = new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('exit', resolvePromise)
    })
    void exitPromise.catch(() => {})
    processExits.set(child, exitPromise)
    try {
      await withTimeout(
        new Promise((resolvePromise, reject) => {
          child.once('spawn', resolvePromise)
          child.once('error', reject)
        }),
        remainingUntil(operationDeadlineAt),
        `Timed out spawning ${command}`
      )
    } catch (error) {
      child.kill?.('SIGKILL')
      processExits.delete(child)
      throw new Error(`Failed to spawn ${command}`, { cause: error })
    }
    const stop = cleanup === 'process' ? stopSingle : stopGroup
    const unregister = register(resourceName, ({ signal, deadlineAt: cleanupDeadline }) =>
      stop(child, { signal, deadlineAt: cleanupDeadline, now })
    )
    processRegistrations.set(child, unregister)
    return child
  }

  const releaseProcess = child => {
    processRegistrations.get(child)?.()
    processRegistrations.delete(child)
    processExits.delete(child)
  }

  const runCommand = async (command, args = [], options = {}) => {
    const commandDeadline = Math.min(
      operationDeadlineAt,
      options.deadlineAt ?? Number.POSITIVE_INFINITY
    )
    const child = await spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      resourceName: options.resourceName || `command: ${command}`,
    })
    const maxOutputChars = options.maxOutputChars ?? 4 * 1024 * 1024
    const collect = stream =>
      new Promise((resolvePromise, reject) => {
        const decoder = new StringDecoder('utf8')
        let output = ''
        stream?.on('data', chunk => {
          output += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          if (output.length > maxOutputChars) output = output.slice(-maxOutputChars)
        })
        stream?.once('error', reject)
        stream?.once('end', () => resolvePromise(output + decoder.end()))
        if (!stream) resolvePromise('')
      })
    const stdoutPromise = collect(child.stdout)
    const stderrPromise = collect(child.stderr)
    void stdoutPromise.catch(() => {})
    void stderrPromise.catch(() => {})
    let terminalConfirmed = false
    try {
      const code = await withTimeout(
        processExits.get(child),
        remainingUntil(commandDeadline),
        `Timed out running ${command} ${args.join(' ')}`
      )
      const [stdout, stderr] = await withTimeout(
        Promise.all([stdoutPromise, stderrPromise]),
        remainingUntil(commandDeadline),
        `Timed out collecting output from ${command}`
      )
      await stopGroup(child, { deadlineAt: cleanupDeadlineAt, now })
      terminalConfirmed = true
      if (code !== 0) {
        throw new Error(
          `${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}: ${stderr || stdout}`
        )
      }
      return { stdout, stderr }
    } catch (primaryError) {
      const recoveryErrors = []
      const recoveryDeadline = cleanupDeadlineAt
      try {
        await stopGroup(child, { deadlineAt: recoveryDeadline, now })
        terminalConfirmed = true
      } catch (error) {
        recoveryErrors.push(
          new Error(`Failed to stop command process group: ${command}`, { cause: error })
        )
      }
      for (const stream of [child.stdout, child.stderr]) stream?.destroy?.()
      try {
        await withTimeout(
          Promise.allSettled([stdoutPromise, stderrPromise]).then(results => {
            const failures = results.filter(result => result.status === 'rejected')
            if (failures.length > 0) {
              throw new AggregateError(
                failures.map(result => result.reason),
                `Failed to drain command output: ${command}`
              )
            }
          }),
          Math.max(1, Math.min(LOG_DRAIN_TIMEOUT_MS, remainingUntil(recoveryDeadline))),
          `Timed out draining command output: ${command}`
        )
      } catch (error) {
        recoveryErrors.push(error)
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...recoveryErrors],
          `Command failed and recovery also failed: ${command}`,
          { cause: primaryError }
        )
      }
      throw primaryError
    } finally {
      if (terminalConfirmed) releaseProcess(child)
    }
  }

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const errors = []
      const cleanupDeadline = cleanupDeadlineAt
      const activeCleanups = [...cleanups].reverse().filter(entry => entry.active)
      for (const [index, { name, cleanup: release }] of activeCleanups.entries()) {
        const abortController = new AbortController()
        const pendingAttempts = activeCleanups.length - index + logPipelines.length
        const timeoutMs = Math.min(
          cleanupTimeoutMs,
          Math.floor(remainingUntil(cleanupDeadline) / Math.max(1, pendingAttempts))
        )
        try {
          if (timeoutMs <= 0) {
            abortController.abort(new Error('Desktop E2E cleanup absolute deadline reached'))
          }
          const releaseResult = release({
            signal: abortController.signal,
            deadlineAt: cleanupDeadline,
          })
          if (timeoutMs <= 0) {
            void Promise.resolve(releaseResult).catch(() => {})
            throw new Error(`Cleanup deadline expired before waiting for resource: ${name}`)
          }
          await withTimeout(
            Promise.resolve(releaseResult),
            timeoutMs,
            `Timed out cleaning desktop E2E resource: ${name}`
          )
        } catch (error) {
          abortController.abort(error)
          errors.push(new Error(`Failed to clean desktop E2E resource: ${name}`, { cause: error }))
        }
      }
      for (const [index, { destination, value }] of logPipelines.entries()) {
        try {
          const pendingDrains = logPipelines.length - index
          const drainDeadline = Math.min(
            cleanupDeadline,
            now() + Math.floor(remainingUntil(cleanupDeadline) / Math.max(1, pendingDrains))
          )
          await value.drain({ deadlineAt: drainDeadline })
        } catch (error) {
          errors.push(
            new Error(`Failed to drain desktop E2E log: ${destination}`, { cause: error })
          )
        }
      }
      for (const [signal, handler] of signalHandlers) processRef.off(signal, handler)
      if (errors.length > 0) throw new AggregateError(errors, 'Desktop E2E cleanup failed')
    })()
    return cleanupPromise
  }

  const installSignalHandlers = (signals = ['SIGINT', 'SIGTERM']) => {
    if (signalHandlers.size > 0) return
    for (const signal of signals) {
      const handler = () => {
        if (signalTriggered) return
        signalTriggered = true
        operationAbortController.abort(new Error(`Desktop E2E operation interrupted by ${signal}`))
        void cleanup()
          .catch(error => processRef.stderr?.write?.(`${String(error)}\n`))
          .finally(() => {
            for (const [name, installed] of signalHandlers) processRef.off(name, installed)
            processRef.kill(processRef.pid, signal)
          })
      }
      signalHandlers.set(signal, handler)
      processRef.once(signal, handler)
    }
  }

  return {
    captureProcessOutput,
    cleanup,
    deadlineAt: operationDeadlineAt,
    installSignalHandlers,
    remainingMs: () => remainingUntil(operationDeadlineAt),
    register,
    releaseProcess,
    runCommand,
    runOperation,
    scenarioDeadlineAt: deadlineAt,
    signal: operationAbortController.signal,
    spawnProcess,
  }
}

function waitForProcessExit(child, timeoutMs, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const finish = error => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolvePromise()
    }
    const onExit = () => finish()
    const onAbort = () =>
      finish(new Error(`Cancelled waiting for process ${child.pid ?? 'unknown'}`))
    const timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for process ${child.pid ?? 'unknown'} to exit`)),
      Math.max(0, timeoutMs)
    )
    child.once('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function isProcessGroupRunning(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGroupExit(
  processGroupId,
  timeoutMs,
  pollIntervalMs = PROCESS_GROUP_POLL_INTERVAL_MS,
  signal
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error(`Cancelled waiting for process group ${processGroupId}`)
    if (!isProcessGroupRunning(processGroupId)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs))
  }
  return !isProcessGroupRunning(processGroupId)
}

export async function stopProcess(
  child,
  {
    stopTimeoutMs = PROCESS_STOP_TIMEOUT_MS,
    deadlineAt = Date.now() + stopTimeoutMs,
    signal,
    now = Date.now,
  } = {}
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const remaining = () => Math.max(0, Math.min(stopTimeoutMs, deadlineAt - now()))
  child.kill('SIGTERM')
  try {
    await waitForProcessExit(child, remaining(), signal)
  } catch {
    if (signal?.aborted || remaining() <= 0)
      throw new Error(`Cancelled stopping process ${child.pid}`)
    child.kill('SIGKILL')
    await waitForProcessExit(child, remaining(), signal)
  }
}

export async function stopProcessGroup(
  child,
  {
    stopTimeoutMs = PROCESS_STOP_TIMEOUT_MS,
    gracePeriodMs = PROCESS_GROUP_GRACE_PERIOD_MS,
    pollIntervalMs = PROCESS_GROUP_POLL_INTERVAL_MS,
    deadlineAt = Date.now() + stopTimeoutMs + gracePeriodMs,
    signal,
    now = Date.now,
  } = {}
) {
  if (!child) return
  if (process.platform === 'win32' || !Number.isInteger(child.pid)) {
    await stopProcess(child, { stopTimeoutMs, deadlineAt, signal, now })
    return
  }

  const processGroupId = child.pid
  const remaining = limit => Math.max(0, Math.min(limit, deadlineAt - now()))
  signalProcessGroup(processGroupId, 'SIGTERM')
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await waitForProcessExit(child, remaining(stopTimeoutMs), signal)
    } catch {
      if (signal?.aborted || remaining(stopTimeoutMs) <= 0) {
        throw new Error(`Cancelled stopping process group ${processGroupId}`)
      }
      signalProcessGroup(processGroupId, 'SIGKILL')
      await waitForProcessExit(child, remaining(stopTimeoutMs), signal)
    }
  }
  if (
    await waitForProcessGroupExit(processGroupId, remaining(gracePeriodMs), pollIntervalMs, signal)
  )
    return
  if (signal?.aborted || remaining(stopTimeoutMs) <= 0) {
    throw new Error(`Cancelled stopping process group ${processGroupId}`)
  }
  signalProcessGroup(processGroupId, 'SIGKILL')
  if (
    !(await waitForProcessGroupExit(
      processGroupId,
      remaining(stopTimeoutMs),
      pollIntervalMs,
      signal
    ))
  ) {
    throw new Error(`Timed out waiting for process group ${processGroupId} to exit`)
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

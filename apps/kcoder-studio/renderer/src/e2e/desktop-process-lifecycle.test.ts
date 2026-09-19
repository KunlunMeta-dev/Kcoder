import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

interface ProcessLifecycle {
  assertDesktopProcessIsolationSupported: (platform?: string) => void
  combinePrimaryAndCleanupErrors: (primary: unknown, cleanup: unknown) => unknown
  createArtifactSink: (options: Record<string, unknown>) => {
    writeJson: (file: string, value: unknown) => Promise<void>
    writeText: (file: string, value: string) => Promise<void>
  }
  createMinimalProcessEnv: (
    source: Record<string, string>,
    overrides?: Record<string, string | undefined>
  ) => Record<string, string>
  createProcessEnvironment: (
    profile: string,
    source: Record<string, string>,
    overrides?: Record<string, string | undefined>
  ) => Record<string, string>
  createProcessLogPipeline: (options: Record<string, unknown>) => {
    attach: (stream: PassThrough) => Promise<void>
    drain: () => Promise<void>
  }
  createRedactedLogRetainer: (options: Record<string, unknown>) => {
    sync: (options?: { final?: boolean }) => Promise<boolean>
  }
  createResourceOwner: (options?: Record<string, unknown>) => {
    captureProcessOutput: (
      stream: PassThrough,
      destination: string,
      options?: Record<string, unknown>
    ) => unknown
    cleanup: () => Promise<void>
    deadlineAt: number
    installSignalHandlers: () => void
    register: (
      name: string,
      cleanup: (context: { deadlineAt: number; signal: AbortSignal }) => unknown
    ) => unknown
    remainingMs: () => number
    runCommand: (
      command: string,
      args: string[],
      options?: Record<string, unknown>
    ) => Promise<{ stdout: string; stderr: string }>
    runOperation: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>
    signal: AbortSignal
    spawnProcess: (
      command: string,
      args: string[],
      options?: Record<string, unknown>
    ) => Promise<ChildProcess>
    scenarioDeadlineAt: number
  }
  redactSensitiveData: (value: unknown, secrets?: string[]) => unknown
  redactSensitiveText: (value: unknown, secrets?: string[]) => string
  stopProcessGroup: (child: ChildProcess, options?: Record<string, number>) => Promise<void>
}

const ownedProcessGroups = new Set<number>()
const temporaryDirectories = new Set<string>()

async function loadProcessLifecycle(): Promise<ProcessLifecycle> {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-lifecycle.mjs')
  ).href
  return import(/* @vite-ignore */ moduleUrl) as Promise<ProcessLifecycle>
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessToStop(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  return !isProcessRunning(pid)
}

async function readChildPid(parent: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    parent.once('error', reject)
    parent.stdout?.once('data', chunk => {
      const childPid = Number.parseInt(String(chunk).trim(), 10)
      if (Number.isInteger(childPid)) {
        resolvePromise(childPid)
        return
      }
      reject(new Error(`Invalid child pid: ${String(chunk)}`))
    })
  })
}

async function recursiveFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(entry => {
        const path = join(root, entry.name)
        return entry.isDirectory() ? recursiveFiles(path) : [path]
      })
    )
  ).flat()
}

afterEach(async () => {
  for (const processGroupId of ownedProcessGroups) {
    try {
      process.kill(-processGroupId, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  ownedProcessGroups.clear()
  await Promise.all(
    [...temporaryDirectories].map(path => rm(path, { recursive: true, force: true }))
  )
  temporaryDirectories.clear()
})

describe('desktop process lifecycle', () => {
  test('runs every cleanup in LIFO order and aggregates failures', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const owner = createResourceOwner()
    const events: string[] = []
    owner.register('first', () => events.push('first'))
    owner.register('broken', () => {
      events.push('broken')
      throw new Error('cleanup failed')
    })
    owner.register('last', () => events.push('last'))

    await expect(owner.cleanup()).rejects.toBeInstanceOf(AggregateError)
    expect(events).toEqual(['last', 'broken', 'first'])
  })

  test('makes repeated cleanup calls share one idempotent result', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const owner = createResourceOwner()
    let calls = 0
    owner.register('once', () => {
      calls += 1
    })

    await Promise.all([owner.cleanup(), owner.cleanup()])
    await owner.cleanup()
    expect(calls).toBe(1)
  })

  test('uses the reserved absolute cleanup interval and attempts every LIFO resource after expiry', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    let now = 0
    const events: string[] = []
    const owner = createResourceOwner({ cleanupTimeoutMs: 100, deadlineAt: 100, now: () => now })
    owner.register('attempted-after-expiry', ({ signal }) =>
      events.push(`attempted-after-expiry:${signal.aborted}`)
    )
    owner.register('expires-budget', () => {
      events.push('expires-budget')
      now = 101
    })

    await expect(owner.cleanup()).rejects.toBeInstanceOf(AggregateError)
    expect(events).toEqual(['expires-budget', 'attempted-after-expiry:true'])
  })

  test('aborts the whole operation at the cleanup reserve boundary before cleanup starts', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const startedAt = Date.now()
    const owner = createResourceOwner({ cleanupTimeoutMs: 80, deadlineAt: startedAt + 160 })
    const events: string[] = []
    owner.register('cleanup', () => events.push('cleanup'))

    await expect(
      owner.runOperation(
        signal =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                events.push('operation-aborted')
                reject(signal.reason)
              },
              { once: true }
            )
          })
      )
    ).rejects.toThrow(/starting cleanup reserve/)
    await owner.cleanup()

    expect(events).toEqual(['operation-aborted', 'cleanup'])
    expect(Date.now() - startedAt).toBeLessThan(300)
  })

  test('removes a private raw-log directory even when an earlier cleanup exhausts its share', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const rawDir = await mkdtemp(join(tmpdir(), 'wework-raw-log-cleanup-'))
    await writeFile(join(rawDir, 'executor.log'), 'private raw log', 'utf8')
    const owner = createResourceOwner({
      cleanupTimeoutMs: 150,
      deadlineAt: Date.now() + 300,
    })
    owner.register('remove raw directory', () => rm(rawDir, { recursive: true, force: true }))
    owner.register('hung process cleanup', () => new Promise(() => {}))

    await expect(owner.cleanup()).rejects.toBeInstanceOf(AggregateError)
    await expect(readFile(join(rawDir, 'executor.log'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('keeps the primary failure first when cleanup also fails', async () => {
    const { combinePrimaryAndCleanupErrors } = await loadProcessLifecycle()
    const primary = new Error('primary')
    const cleanup = new Error('cleanup')
    const combined = combinePrimaryAndCleanupErrors(primary, cleanup) as AggregateError
    expect(combined.cause).toBe(primary)
    expect(combined.errors).toEqual([primary, cleanup])
  })

  test('handles only the first termination signal and restores signal exit semantics', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const processRef = Object.assign(new EventEmitter(), {
      pid: 4321,
      stderr: { write() {} },
      kill: vi.fn(),
    })
    const owner = createResourceOwner({ processRef })
    let cleanupCalls = 0
    owner.register('signal cleanup', async () => {
      cleanupCalls += 1
    })
    owner.installSignalHandlers()

    processRef.emit('SIGTERM')
    processRef.emit('SIGINT')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))

    expect(cleanupCalls).toBe(1)
    expect(owner.signal.aborted).toBe(true)
    expect(processRef.kill).toHaveBeenCalledTimes(1)
    expect(processRef.kill).toHaveBeenCalledWith(4321, 'SIGTERM')
  })

  test('serializes log writes and redacts secrets split across stream chunks', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const writes: string[] = []
    const pipeline = createProcessLogPipeline({
      destination: '/logs/app.log',
      secrets: ['token-secret'],
      appendFile: async (_destination: string, value: string) => {
        writes.push(value)
      },
    })
    const stream = new PassThrough()
    void pipeline.attach(stream)
    stream.write('first token-')
    stream.write('secret\nsecond\n')
    stream.end()

    await pipeline.drain()
    expect(writes.join('')).toBe('first [REDACTED]\nsecond\n')
  })

  test('decodes split UTF-8 and flushes bounded non-newline logs without exposing overlap', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const writes: string[] = []
    const pipeline = createProcessLogPipeline({
      destination: '/logs/bounded.log',
      secrets: ['秘密TOKEN'],
      maxBufferedChars: 8,
      appendFile: async (_destination: string, value: string) => writes.push(value),
    })
    const stream = new PassThrough()
    void pipeline.attach(stream)
    const bytes = Buffer.from('prefix-秘密TOKEN-suffix-without-newline')
    stream.write(bytes.subarray(0, 9))
    stream.write(bytes.subarray(9, 14))
    stream.write(bytes.subarray(14))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(writes.length).toBeGreaterThan(0)
    stream.end()

    await pipeline.drain()
    expect(writes.join('')).toBe('prefix-[REDACTED]-suffix-without-newline')
  })

  test('retains secret prefixes across newline flushes and split UTF-8 chunks', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const secret = 'selector\n秘密🔐TOKEN'
    const writes: string[] = []
    const pipeline = createProcessLogPipeline({
      destination: '/logs/newline-secret.log',
      secrets: () => [secret],
      maxBufferedChars: 6,
      appendFile: async (_destination: string, value: string) => writes.push(value),
    })
    const stream = new PassThrough()
    void pipeline.attach(stream)
    const bytes = Buffer.from(`before ${secret} after\n`)
    let start = 0
    for (const boundary of [9, 12, 15, 18, bytes.length]) {
      stream.write(bytes.subarray(start, boundary))
      start = boundary
    }
    stream.end()

    await pipeline.drain()
    expect(writes.join('')).toBe('before [REDACTED] after\n')
    expect(writes.every(write => !write.includes(secret))).toBe(true)
  })

  test('propagates reader and sink failures through log drain', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const readerPipeline = createProcessLogPipeline({
      destination: '/logs/reader.log',
      appendFile: async () => {},
    })
    const brokenReader = new PassThrough()
    void readerPipeline.attach(brokenReader)
    brokenReader.destroy(new Error('reader failed'))
    await expect(readerPipeline.drain()).rejects.toThrow('reader failed')

    const sinkPipeline = createProcessLogPipeline({
      destination: '/logs/sink.log',
      appendFile: async () => {
        throw new Error('sink failed')
      },
    })
    const sinkStream = new PassThrough()
    void sinkPipeline.attach(sinkStream)
    sinkStream.end('line\n')
    await expect(sinkPipeline.drain()).rejects.toThrow('sink failed')
  })

  test('reports process stream failures through owner cleanup', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const owner = createResourceOwner()
    const stream = new PassThrough()
    owner.captureProcessOutput(stream, '/logs/owned.log', {
      appendFile: async () => {
        throw new Error('owned sink failed')
      },
    })
    stream.end('line\n')

    await expect(owner.cleanup()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: expect.stringContaining('owned.log') })],
    })
  })

  test('bounds log drain when a process stream never closes', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const pipeline = createProcessLogPipeline({
      destination: '/logs/hung.log',
      appendFile: async () => {},
      drainTimeoutMs: 5,
    })
    const stream = new PassThrough()
    void pipeline.attach(stream)
    await expect(pipeline.drain()).rejects.toThrow(/Timed out draining/)
    stream.end()
  })

  test('aborts a timed-out sink and prevents later writes', async () => {
    const { createProcessLogPipeline } = await loadProcessLifecycle()
    const writes: string[] = []
    const pipeline = createProcessLogPipeline({
      destination: '/logs/late.log',
      drainTimeoutMs: 5,
      maxBufferedChars: 4,
      appendFile: async (_destination: string, value: string) => {
        writes.push(value)
        await new Promise(() => {})
      },
    })
    const stream = new PassThrough()
    void pipeline.attach(stream)
    stream.write('first-write')
    await expect(pipeline.drain()).rejects.toThrow(/Timed out draining/)
    const countAfterTimeout = writes.length
    stream.write('must-not-write')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(writes).toHaveLength(countAfterTimeout)
  })

  test('builds a minimal child environment without unrelated inherited secrets', async () => {
    const { createMinimalProcessEnv, redactSensitiveData, redactSensitiveText } =
      await loadProcessLifecycle()
    const env = createMinimalProcessEnv(
      {
        PATH: '/bin',
        HOME: '/home/test',
        DISPLAY: ':1',
        RUSTUP_HOME: '/rustup',
        CODEX_HOME: '/codex',
        UNRELATED_SECRET: 'must-not-leak',
      },
      { DEVICE_ID: 'device', HOME: '/isolated', CODEX_HOME: undefined }
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/isolated',
      DISPLAY: ':1',
      RUSTUP_HOME: '/rustup',
      DEVICE_ID: 'device',
    })
    expect(
      redactSensitiveData({ authorization: 'Bearer secret', nested: { token: 'secret' } })
    ).toEqual({ authorization: '[REDACTED]', nested: { token: '[REDACTED]' } })
    expect(
      redactSensitiveText('Authorization: Bearer auth-value token=token-value', [
        'auth-value',
        'token-value',
      ])
    ).toBe('Authorization: Bearer [REDACTED] token=[REDACTED]')
  })

  test('runs a real child with its selected environment profile only', async () => {
    const { createProcessEnvironment, createResourceOwner } = await loadProcessLifecycle()
    const owner = createResourceOwner({ deadlineAt: Date.now() + 10_000 })
    const env = createProcessEnvironment(
      'runtime',
      { PATH: process.env.PATH!, HOME: '/source-home', UNRELATED_SECRET: 'hidden' },
      { HOME: '/isolated-home', CHILD_MARKER: 'visible', CODEX_HOME: undefined }
    )
    const result = await owner.runCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({home:process.env.HOME,marker:process.env.CHILD_MARKER,secret:process.env.UNRELATED_SECRET,codex:process.env.CODEX_HOME}))',
      ],
      { env }
    )
    await owner.cleanup()

    expect(JSON.parse(result.stdout)).toEqual({ home: '/isolated-home', marker: 'visible' })
  })

  test('redacts every artifact sink before persistence', async () => {
    const { createArtifactSink } = await loadProcessLifecycle()
    const writes: string[] = []
    const sink = createArtifactSink({
      secrets: ['artifact-secret'],
      writeFile: async (_file: string, value: string) => writes.push(value),
    })
    await sink.writeJson('/artifacts/state.json', {
      authorization: 'Bearer auth',
      detail: 'artifact-secret',
    })
    await sink.writeText('/artifacts/ui.txt', 'token=artifact-secret')

    expect(writes.join('\n')).not.toMatch(/artifact-secret|Bearer auth/)
    expect(writes.join('\n')).toContain('[REDACTED]')
  })

  test('retains sidecar logs through the streaming redactor and leaves no raw secret artifact', async () => {
    const { createArtifactSink, createRedactedLogRetainer } = await loadProcessLifecycle()
    const root = await mkdtemp(join(tmpdir(), 'wework-redacted-artifacts-'))
    temporaryDirectories.add(root)
    const sourceDir = await mkdtemp(join(tmpdir(), 'wework-private-sidecar-'))
    temporaryDirectories.add(sourceDir)
    const source = join(sourceDir, 'executor.log')
    const destination = join(root, 'nested', 'executor.log')
    const selectorSecret = '[data-testid="private-token"]'
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(source, `prefix ${selectorSecret.slice(0, 13)}`, 'utf8')
    const retainer = createRedactedLogRetainer({
      source,
      destination,
      secrets: () => [selectorSecret],
      readChunkBytes: 3,
    })
    await retainer.sync()
    await appendFile(source, `${selectorSecret.slice(13)} suffix\n`, 'utf8')
    await retainer.sync({ final: true })
    const artifactSink = createArtifactSink({ secrets: () => [selectorSecret] })
    await artifactSink.writeJson(join(root, 'nested', 'state.json'), {
      selector: selectorSecret,
    })

    const files = await recursiveFiles(root)
    const retained = await Promise.all(files.map(file => readFile(file, 'utf8')))
    expect(retained.join('\n')).not.toContain(selectorSecret)
    expect(retained.join('\n')).toContain('[REDACTED]')
    await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects Windows real-entry process isolation until Job Object support exists', async () => {
    const { assertDesktopProcessIsolationSupported } = await loadProcessLifecycle()
    expect(() => assertDesktopProcessIsolationSupported('linux')).not.toThrow()
    expect(() => assertDesktopProcessIsolationSupported('win32')).toThrow(/Job Object/)
  })

  test('reserves cleanup time while exposing the scenario and operation deadlines', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    let now = 100
    const owner = createResourceOwner({ cleanupTimeoutMs: 80, deadlineAt: 200, now: () => now })
    expect(owner.scenarioDeadlineAt).toBe(200)
    expect(owner.deadlineAt).toBe(150)
    expect(owner.remainingMs()).toBe(50)
    let cleanupDeadline = 0
    owner.register('expired scenario cleanup', context => {
      cleanupDeadline = (context as { deadlineAt: number }).deadlineAt
    })
    now = 201
    await expect(owner.cleanup()).rejects.toBeInstanceOf(AggregateError)
    expect(cleanupDeadline).toBe(200)
  })

  test('stops a real descendant holding command pipes before releasing command ownership', async () => {
    if (process.platform === 'win32') return
    const { createResourceOwner } = await loadProcessLifecycle()
    const root = await mkdtemp(join(tmpdir(), 'wework-command-pipe-'))
    temporaryDirectories.add(root)
    const pidFile = join(root, 'descendant.pid')
    const owner = createResourceOwner({
      cleanupTimeoutMs: 2_000,
      deadlineAt: Date.now() + 3_000,
    })
    const descendantScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    const leaderScript = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','inherit','inherit']})`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      'child.unref()',
    ].join(';')

    await expect(
      owner.runCommand(process.execPath, ['-e', leaderScript], {
        deadlineAt: Date.now() + 100,
      })
    ).rejects.toThrow(/Timed out collecting output/)
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
    expect(await waitForProcessToStop(descendantPid, 1_000)).toBe(true)
    await owner.cleanup()
  })

  test('aggregates stream and stop failures without unregistering an unconfirmed process', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdout,
      stderr,
      kill: vi.fn(),
    }) as unknown as ChildProcess
    const stopGroup = vi.fn(async () => {
      throw new Error('terminal state unknown')
    })
    const owner = createResourceOwner({
      deadlineAt: Date.now() + 2_000,
      spawn: () => {
        queueMicrotask(() => {
          child.emit('spawn')
          stdout.destroy(new Error('stdout failed'))
          stderr.end()
          child.emit('exit', 0)
        })
        return child
      },
      stopGroup,
    })

    const failure = (await owner.runCommand('probe').catch(error => error)) as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0].message).toBe('stdout failed')
    expect(failure.errors.some((error: Error) => error.message.includes('stop command'))).toBe(true)
    await expect(owner.cleanup()).rejects.toBeInstanceOf(AggregateError)
    expect(stopGroup).toHaveBeenCalledTimes(2)
  })

  test('centralizes asynchronous spawn failures in the owner', async () => {
    const { createResourceOwner } = await loadProcessLifecycle()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    const owner = createResourceOwner({
      deadlineAt: Date.now() + 1_000,
      spawn: () => {
        queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        return child
      },
    })

    await expect(owner.spawnProcess('missing', [])).rejects.toThrow(/Failed to spawn missing/)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('stops descendants that inherit an owned process group', async () => {
    const { stopProcessGroup } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const childScript = \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\"",
          "const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'ignore'] })",
          "child.stdout.once('data', () => console.log(child.pid))",
          'setInterval(() => {}, 1000)',
        ].join(';'),
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )
    expect(parent.pid).toBeTypeOf('number')
    ownedProcessGroups.add(parent.pid!)
    const childPid = await readChildPid(parent)
    const stopStartedAt = Date.now()

    await stopProcessGroup(parent, {
      stopTimeoutMs: 1_000,
      gracePeriodMs: 250,
      pollIntervalMs: 10,
    })

    expect(await waitForProcessToStop(childPid, 1_000)).toBe(true)
    expect(Date.now() - stopStartedAt).toBeLessThan(2_000)
    ownedProcessGroups.delete(parent.pid!)
  })

  test('kills an ignoring descendant after its process-group leader exits on Linux', async () => {
    if (process.platform === 'win32') return
    const { stopProcessGroup } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] })",
          "child.stdout.once('data', () => { console.log(child.pid); setTimeout(() => process.exit(0), 25) })",
        ].join(';'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    expect(parent.pid).toBeTypeOf('number')
    ownedProcessGroups.add(parent.pid!)
    const childPid = await readChildPid(parent)
    await new Promise(resolvePromise => parent.once('exit', resolvePromise))
    const stopStartedAt = Date.now()

    await stopProcessGroup(parent, {
      stopTimeoutMs: 1_000,
      gracePeriodMs: 250,
      pollIntervalMs: 10,
    })

    expect(await waitForProcessToStop(childPid, 1_000)).toBe(true)
    expect(Date.now() - stopStartedAt).toBeLessThan(2_000)
    ownedProcessGroups.delete(parent.pid!)
  })

  test('kills both a process-group leader and descendant that ignore SIGTERM on Linux', async () => {
    if (process.platform === 'win32') return
    const { stopProcessGroup } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "process.on('SIGTERM', () => {})",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] })",
          "child.stdout.once('data', () => console.log(child.pid))",
          'setInterval(() => {}, 1000)',
        ].join(';'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    expect(parent.pid).toBeTypeOf('number')
    ownedProcessGroups.add(parent.pid!)
    const childPid = await readChildPid(parent)
    const stopStartedAt = Date.now()

    await stopProcessGroup(parent, {
      stopTimeoutMs: 1_000,
      gracePeriodMs: 250,
      pollIntervalMs: 10,
    })

    expect(await waitForProcessToStop(parent.pid!, 1_000)).toBe(true)
    expect(await waitForProcessToStop(childPid, 1_000)).toBe(true)
    expect(Date.now() - stopStartedAt).toBeLessThan(2_000)
    ownedProcessGroups.delete(parent.pid!)
  })
})

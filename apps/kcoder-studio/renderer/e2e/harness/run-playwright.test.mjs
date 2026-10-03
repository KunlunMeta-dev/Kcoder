import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { PassThrough, Transform, Writable } from 'node:stream'
import test from 'node:test'
import { processTreeAlive } from '../../../e2e/harness/owned-process.mjs'
import {
  OwnedPlaywrightRun,
  createLogWorker,
  runOwnedPlaywright,
  validSuccessfulSummary,
} from './run-playwright.mjs'

test('parallel owned runs use distinct OS-selected ports and report real READY addresses', async () => {
  const first = await OwnedPlaywrightRun.create()
  const second = await OwnedPlaywrightRun.create()
  try {
    const [firstUrls, secondUrls] = await Promise.all([
      first.startServices(),
      second.startServices(),
    ])
    const firstPorts = Object.values(first.services).map(item => item.port)
    const secondPorts = Object.values(second.services).map(item => item.port)
    assert.equal(firstPorts.length, 4)
    assert.equal(new Set([...firstPorts, ...secondPorts]).size, 8)
    for (const url of [...Object.values(firstUrls), ...Object.values(secondUrls)]) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    }
    assert.equal((await fetch(`${firstUrls.responses}/health`)).status, 200)
    assert.equal((await fetch(`${secondUrls.connector}/health`)).status, 200)
  } finally {
    await Promise.all([first.finish('passed'), second.finish('passed')])
  }
})

test('occupied legacy ports remain untouched while owned services bind dynamic ports', async () => {
  let probes = 0
  const occupied = await Promise.all(
    [9996, 9997, 9998, 4174].map(port => occupy(port, () => probes++))
  )
  const run = await OwnedPlaywrightRun.create()
  try {
    const urls = await run.startServices()
    assert.equal(
      Object.values(run.services).some(item => [9996, 9997, 9998, 4174].includes(item.port)),
      false
    )
    assert.equal(probes, 0, 'owner must trust child READY, not a pre-existing health endpoint')
    assert.equal((await fetch(`${urls.sites}/health`)).status, 200)
  } finally {
    await run.finish('passed')
    await Promise.all(occupied.map(server => close(server)))
  }
})

test('failure cleanup stops every owned process in LIFO order', async () => {
  const run = await OwnedPlaywrightRun.create()
  await run.startServices()
  const records = [...run.processes]
  await run.finish('failed', new Error('injected harness failure'))

  assert.deepEqual(
    run.cleanupSteps.slice(0, records.length).map(step => step.label),
    [...records].reverse().map(record => record.label)
  )
  assert.equal(run.cleanupSteps.at(-1)?.label, 'remove run state')
  for (const record of records) {
    assert.equal(await processTreeAlive(record.child, record.identity), false)
  }
  const result = JSON.parse(await readFile(`${run.artifactsDir}/result.json`, 'utf8'))
  assert.equal(result.status, 'failed')
})

test('SIGTERM waits for owned service cleanup before rejecting the run', async () => {
  const signals = new EventEmitter()
  let observedRun
  await assert.rejects(
    runOwnedPlaywright(['test'], {
      signalTarget: signals,
      holdAfterReady: true,
      onServicesReady(run) {
        observedRun = run
        signals.emit('SIGTERM')
      },
    }),
    /received SIGTERM/
  )
  assert.ok(observedRun)
  assert.equal(observedRun.finished, true)
  assert.equal(observedRun.cleanupSteps.length, 5)
  for (const record of observedRun.processes) {
    assert.equal(await processTreeAlive(record.child, record.identity), false)
  }
})

test('minimal environments omit unrelated secrets and owned logs redact drained tail output', async () => {
  process.env.KCODER_STUDIO_UNRELATED_SECRET = 'UNRELATED_SECRET_VALUE'
  const run = await OwnedPlaywrightRun.create()
  const explicitSecret = 'EXPLICIT_LOG_SECRET_123'
  run.registerSecret(explicitSecret)
  try {
    const env = run.childEnvironment({ EXPLICIT_SECRET: explicitSecret })
    assert.equal(env.KCODER_STUDIO_UNRELATED_SECRET, undefined)
    const args = [
      '-e',
      "process.stdout.write(process.env.EXPLICIT_SECRET);process.stderr.write('TAIL_MARKER')",
    ]
    const record = run.spawnOwned('redacted-tail', process.execPath, args, env)
    await new Promise((resolveExit, reject) => {
      record.child.once('exit', resolveExit)
      record.child.once('error', reject)
    })
    await run.finish('passed')
    const log = await readFile(`${run.logsDir}/redacted-tail.log`, 'utf8')
    assert.equal(log.includes(explicitSecret), false)
    assert.match(log, /\[REDACTED\]/)
    assert.match(log, /TAIL_MARKER/)
    const manifest = JSON.parse(await readFile(`${run.runRoot}/manifest.json`, 'utf8'))
    assert.equal(manifest.processes[0].command, process.execPath)
    assert.deepEqual(manifest.processes[0].argv, args)
  } finally {
    delete process.env.KCODER_STUDIO_UNRELATED_SECRET
  }
})

test('log worker rejects an injected reader failure', async () => {
  const reader = new PassThrough()
  const redactor = new PassThrough()
  const destination = new PassThrough()
  const worker = createLogWorker(reader, redactor, destination)

  reader.destroy(new Error('injected reader failure'))

  await assert.rejects(worker.completion, /injected reader failure/)
  redactor.destroy()
  destination.destroy()
})

test('log worker rejects an injected redactor failure', async () => {
  const reader = new PassThrough()
  const redactor = new Transform({
    transform(_chunk, _encoding, callback) {
      callback(new Error('injected redactor failure'))
    },
  })
  const destination = new PassThrough()
  const worker = createLogWorker(reader, redactor, destination)

  reader.end('sensitive output')

  await assert.rejects(worker.completion, /injected redactor failure/)
  reader.destroy()
  destination.destroy()
})

test('log worker rejects an injected write-stream failure', async () => {
  const reader = new PassThrough()
  const redactor = new PassThrough()
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('injected write-stream failure'))
    },
  })
  const worker = createLogWorker(reader, redactor, destination)

  reader.end('output')

  await assert.rejects(worker.completion, /injected write-stream failure/)
  assert.equal(reader.destroyed, true)
  assert.equal(redactor.destroyed, true)
})

test('drain failure is recorded as cleanup evidence and force-closes the pipeline', async () => {
  const run = await OwnedPlaywrightRun.create()
  const reader = new PassThrough()
  const redactor = new Transform({
    transform(_chunk, _encoding, callback) {
      callback(new Error('injected cleanup redactor failure'))
    },
  })
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const worker = createLogWorker(reader, redactor, destination)
  const record = {
    label: 'injected-output',
    child: { exitCode: 0, signalCode: null },
    identity: { pid: null, pgid: null },
    log: destination,
    drains: [worker.completion],
    outputWorkers: [worker],
  }
  run.processes.push(record)
  reader.end('output')

  await assert.rejects(run.finish('passed'), /owned E2E cleanup failed/)

  assert.equal(reader.destroyed, true)
  assert.equal(redactor.destroyed, true)
  assert.equal(destination.destroyed, true)
  assert.match(run.cleanupSteps[0]?.error ?? '', /injected cleanup redactor failure/)
  const result = JSON.parse(await readFile(`${run.artifactsDir}/result.json`, 'utf8'))
  assert.equal(result.status, 'failed')
})

test('drain timeout is bounded and still closes every output stream with failure evidence', async () => {
  const run = await OwnedPlaywrightRun.create({
    stopRecordOptions: { drainTimeoutMs: 20, logCloseTimeoutMs: 20 },
  })
  const reader = new PassThrough()
  const redactor = new PassThrough()
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  reader.pipe(redactor).pipe(destination, { end: false })
  const neverSettles = new Promise(() => {})
  run.processes.push({
    label: 'stalled-output',
    child: { exitCode: 0, signalCode: null },
    identity: { pid: null, pgid: null },
    log: destination,
    drains: [neverSettles],
    outputWorkers: [{ source: reader, redactor, destination, completion: neverSettles }],
  })

  await assert.rejects(run.finish('passed'), /owned E2E cleanup failed/)

  assert.equal(reader.destroyed, true)
  assert.equal(redactor.destroyed, true)
  assert.equal(destination.destroyed, true)
  assert.equal(run.cleanupSteps[0]?.status, 'failed')
  assert.match(run.cleanupSteps[0]?.error ?? '', /stalled-output output drain timed out/)
  const result = JSON.parse(await readFile(`${run.artifactsDir}/result.json`, 'utf8'))
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /stalled-output output drain timed out/)
})

test('list-only summaries require only a parsed positive total', () => {
  const allSkipped = { total: 2, passed: 0, failed: 0, skipped: 2, flaky: 0 }
  assert.equal(validSuccessfulSummary(allSkipped, { listOnly: true }), true)
  assert.equal(validSuccessfulSummary({ ...allSkipped, total: 0 }, { listOnly: true }), false)
  assert.equal(validSuccessfulSummary(null, { listOnly: true }), false)
})

test('ordinary summaries allow partial skips but reject all-skipped and failed runs', () => {
  const partialSkipped = { total: 3, passed: 2, failed: 0, skipped: 1, flaky: 0 }
  const allSkipped = { total: 2, passed: 0, failed: 0, skipped: 2, flaky: 0 }
  const failed = { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0 }

  assert.equal(validSuccessfulSummary(partialSkipped), true)
  assert.equal(validSuccessfulSummary(allSkipped), false)
  assert.equal(validSuccessfulSummary(failed), false)
})

test('runPlaywright rejects coerced or incomplete raw reporter counts in every summary mode', async () => {
  const invalidReports = [
    ['string', { expected: '1', unexpected: 0, skipped: 0, flaky: 0 }],
    ['boolean', { expected: true, unexpected: 0, skipped: 0, flaky: 0 }],
    ['array', { expected: [1], unexpected: 0, skipped: 0, flaky: 0 }],
    ['missing', { expected: 1, unexpected: 0, skipped: 0 }],
  ]

  for (const [label, stats] of invalidReports) {
    for (const listOnly of [false, true]) {
      const run = await OwnedPlaywrightRun.create()
      injectFakeServices(run)
      await writeFile(
        `${run.artifactsDir}/playwright-results.json`,
        `${JSON.stringify({ stats })}\n`
      )
      const args = listOnly ? ['--version', '--list'] : ['--version']

      await assert.rejects(
        run.runPlaywright(args),
        /without a valid passing JSON report/,
        `${label} count must fail when listOnly=${listOnly}`
      )
      await run.finish('failed', new Error(`invalid ${label} reporter count`))
    }
  }
})

test('ordinary exit zero with an all-skipped JSON report cannot pass', async () => {
  const run = await OwnedPlaywrightRun.create()
  injectFakeServices(run)
  await writeFile(
    `${run.artifactsDir}/playwright-results.json`,
    `${JSON.stringify({
      stats: { expected: 0, unexpected: 0, skipped: 2, flaky: 0 },
    })}\n`
  )

  await assert.rejects(run.runPlaywright(['--version']), /without a valid passing JSON report/)
  await run.finish('failed', new Error('all tests skipped'))
})

test('a non-UI exit zero without a JSON reporter cannot pass', async () => {
  const run = await OwnedPlaywrightRun.create()
  injectFakeServices(run)
  await assert.rejects(run.runPlaywright(['--version']), /without a valid passing JSON report/)
  await run.finish('failed', new Error('missing reporter proof'))
})

function injectFakeServices(run) {
  run.services = Object.fromEntries(
    ['responses', 'sites', 'connector', 'vite'].map((name, index) => [
      name,
      { service: name, host: '127.0.0.1', port: 40000 + index },
    ])
  )
}

async function occupy(port, onRequest) {
  const server = createServer((_request, response) => {
    onRequest()
    response.writeHead(418).end('legacy')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  return server
}

function close(server) {
  return new Promise((resolveClose, reject) =>
    server.close(error => (error ? reject(error) : resolveClose()))
  )
}

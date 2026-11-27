import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const timeoutOverride = process.env.KCODER_WORKSPACE_HANDSHAKE_TIMEOUT_MS
const confirm12sTimeoutOnly = process.env.KCODER_WORKSPACE_HANDSHAKE_12S_ONLY === '1'
if (confirm12sTimeoutOnly && timeoutOverride !== undefined && Number(timeoutOverride) !== 12_000) {
  throw new Error('KCODER_WORKSPACE_HANDSHAKE_12S_ONLY=1 requires KCODER_WORKSPACE_HANDSHAKE_TIMEOUT_MS to be unset or exactly 12000')
}
const handshakeTimeoutMs = confirm12sTimeoutOnly ? 12_000 : Number(timeoutOverride || 300)
assert.ok(Number.isInteger(handshakeTimeoutMs) && handshakeTimeoutMs >= 100 && handshakeTimeoutMs <= 30_000)
if (confirm12sTimeoutOnly) assert.equal(handshakeTimeoutMs, 12_000)

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await pause(intervalMs)
  }
  throw new Error(message)
}

function encodeClientFrame(value, opcode = 1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const mask = Buffer.from([0x51, 0x62, 0x73, 0x84])
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

function createGatewaySocket({ port, rpcToken, accessToken, serverId, workspace, socketWaitMs = Math.max(2_000, handshakeTimeoutMs + 2_000) }) {
  const startedAt = Date.now()
  const socket = createConnection({ host: '127.0.0.1', port })
  let handshakeDone = false
  let handshakeStatus = null
  let httpBuffer = Buffer.alloc(0)
  let frameBuffer = Buffer.alloc(0)
  const messages = []
  const waiters = []
  let socketError = null
  let closeResolve
  let finishHandshake = null
  let handshakeTimer = null
  let handshakePoll = null
  const closed = new Promise(resolve => { closeResolve = resolve })

  const deliver = message => {
    const index = waiters.findIndex(waiter => waiter.predicate(message))
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    } else {
      messages.push(message)
    }
  }

  const parseFrames = chunk => {
    frameBuffer = Buffer.concat([frameBuffer, chunk])
    while (frameBuffer.length >= 2) {
      const opcode = frameBuffer[0] & 0x0f
      let length = frameBuffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (frameBuffer.length < 4) return
        length = frameBuffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (frameBuffer.length < 10) return
        const wideLength = frameBuffer.readBigUInt64BE(2)
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Gateway frame exceeded the test decoder limit')
        length = Number(wideLength)
        offset = 10
      }
      if (frameBuffer.length < offset + length) return
      const payload = frameBuffer.subarray(offset, offset + length)
      frameBuffer = frameBuffer.subarray(offset + length)
      if (opcode === 1) {
        deliver(JSON.parse(payload.toString('utf8')))
      } else if (opcode === 9) {
        socket.write(encodeClientFrame(payload, 10))
      } else if (opcode === 8) {
        socket.end(encodeClientFrame(payload, 8))
      }
    }
  }

  socket.on('error', error => { socketError = error.code || error.name || 'socket-error' })
  socket.on('close', () => {
    closeResolve()
    if (!handshakeDone) {
      handshakeDone = true
      handshakeStatus = null
      finishHandshake?.()
    }
    if (handshakeTimer) clearTimeout(handshakeTimer)
    if (handshakePoll) clearInterval(handshakePoll)
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`WebSocket closed before the expected response (${socketError || 'closed'})`))
    }
  })
  socket.on('connect', () => {
    const path = `/rpc?token=${encodeURIComponent(rpcToken)}&server=${encodeURIComponent(serverId)}&workspace=${encodeURIComponent(workspace)}`
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: d29ya3NwYWNlLWhhbmRzaGFrZS1yZXBybw==',
      'Sec-WebSocket-Version: 13',
      `Origin: http://127.0.0.1:${port}`,
      `Authorization: Bearer ${accessToken}`,
      '',
      '',
    ].join('\r\n'))
  })
  socket.on('data', chunk => {
    if (!handshakeDone) {
      httpBuffer = Buffer.concat([httpBuffer, chunk])
      const boundary = httpBuffer.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const headers = httpBuffer.subarray(0, boundary).toString('latin1')
      const status = headers.match(/^HTTP\/1\.1 (\d{3})/m)
      handshakeStatus = status ? Number(status[1]) : null
      handshakeDone = true
      const remainder = httpBuffer.subarray(boundary + 4)
      httpBuffer = Buffer.alloc(0)
      if (remainder.length) parseFrames(remainder)
      return
    }
    parseFrames(chunk)
  })

  const result = new Promise((resolve, reject) => {
    handshakeTimer = setTimeout(() => {
      socket.destroy()
      if (handshakePoll) clearInterval(handshakePoll)
      reject(new Error(`Gateway did not complete or reject the WebSocket upgrade within ${socketWaitMs}ms`))
    }, socketWaitMs)
    const check = () => {
      if (!handshakeDone) return
      if (handshakeTimer) clearTimeout(handshakeTimer)
      if (handshakePoll) clearInterval(handshakePoll)
      resolve({
        status: handshakeStatus,
        elapsedMs: Date.now() - startedAt,
        socket,
        closed,
        socketError,
        messages,
        waitForMessage(predicate, timeoutMs = 2_000) {
          const index = messages.findIndex(predicate)
          if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
          return new Promise((resolveMessage, rejectMessage) => {
            const waiter = {
              predicate,
              resolve: resolveMessage,
              reject: rejectMessage,
              timer: setTimeout(() => {
                const waiterIndex = waiters.indexOf(waiter)
                if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)
                rejectMessage(new Error('timed out waiting for the expected Gateway RPC response'))
              }, timeoutMs),
            }
            waiters.push(waiter)
          })
        },
        send(message) {
          socket.write(encodeClientFrame(JSON.stringify(message)))
        },
        destroy() {
          if (!socket.destroyed) socket.destroy()
        },
      })
    }
    finishHandshake = check
    handshakePoll = setInterval(check, 1)
  })
  return result
}

function fakeAppServerSource(tracePath, delayFile, idleLifecycle = false, shutdownDelayMs = 0) {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = ${JSON.stringify(tracePath)};
const delayFile = ${JSON.stringify(delayFile)};
const record = (event, fields = {}) => appendFileSync(trace, JSON.stringify({ event, pid: process.pid, workspace: process.cwd(), ...fields }) + '\\n');
record('spawn');
process.on('SIGTERM', () => { record('exit'); process.exit(0); });
process.on('SIGINT', () => { record('exit'); process.exit(0); });
createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (${idleLifecycle} && request.method === 'server/resources/read') {
    record('idle-resources');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { instanceId: 'owned-fixture', processId: process.pid, residentBytes: 1, memorySource: 'linux-vmrss', includesChildren: false } }) + '\\n');
    return;
  }
  if (${idleLifecycle} && request.method === 'server/shutdown/idle') {
    record('idle-shutdown');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { accepted: true } }) + '\\n');
      setTimeout(() => { record('exit'); process.exit(0); }, 20);
    }, ${shutdownDelayMs});
    return;
  }
  if (request.method !== 'initialize') return;
  let delayMs = 0;
  try { delayMs = Number(JSON.parse(readFileSync(delayFile, 'utf8')).delayMs) || 0; } catch {}
  record('initialize-received', { requestId: request.id, receivedAt: Date.now(), delayMs });
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2026-07-27',
      serverInfo: { name: 'workspace-handshake-fixture', version: '1' },
      capabilities: { experimental: { residentThreads: true, serverIdleShutdownV1: ${idleLifecycle} } },
    } }) + '\\n');
    record('initialize-replied', { requestId: request.id, repliedAt: Date.now(), delayMs });
  }, delayMs);
});
setInterval(() => {}, 1000);
`
}

async function makeRig(label, { idleMs = 300000, maxConnections = 256, idleLifecycle = false, shutdownDelayMs = 0, socketWaitMs } = {}) {
  const state = mkdtempSync(join(tmpdir(), `kcoder-workspace-handshake-${label}-`))
  const webRoot = join(state, 'web')
  const workspaceA = join(state, 'workspace-A')
  const workspaceB = join(state, 'workspace-B')
  const command = join(state, 'app-server-fixture')
  const delayFile = join(state, 'initialize-delay.json')
  const tracePath = join(state, 'app-server-trace.jsonl')
  const store = join(state, 'servers.json')
  mkdirSync(webRoot)
  mkdirSync(workspaceA)
  mkdirSync(workspaceB)
  writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body>Owned gateway fixture</body></html>')
  writeFileSync(delayFile, JSON.stringify({ delayMs: 0 }))
  writeFileSync(tracePath, '')
  writeFileSync(command, fakeAppServerSource(tracePath, delayFile, idleLifecycle, shutdownDelayMs), { mode: 0o755 })
  chmodSync(command, 0o755)
  writeFileSync(store, JSON.stringify([
    { id: 'workspace-target', label: 'Workspace target', runtime: 'kcoder', transport: 'local', workspace: workspaceA, command },
  ]))

  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      KCODER_STUDIO_TEST_DISABLE_AUTH: '',
      HOME: state,
      USERPROFILE: state,
      XDG_CONFIG_HOME: state,
      KCODER_CONFIG_DIR: join(state, 'profile'),
      KCODER_STUDIO_HOST: '127.0.0.1',
      KCODER_STUDIO_PORT: '0',
      KCODER_STUDIO_AUTH_TOKEN: 'isolated-handshake-test-token',
      KCODER_STUDIO_SERVERS_STORE: store,
      KCODER_STUDIO_SERVERS_FILE: '',
      KCODER_STUDIO_SERVERS: '',
      KCODER_STUDIO_WORKSPACE: workspaceA,
      KCODER_STUDIO_WEB_ROOT: webRoot,
      KCODER_STUDIO_HEALTH_TIMEOUT_MS: String(handshakeTimeoutMs),
      KCODER_STUDIO_APP_SERVER_IDLE_MS: String(idleMs),
      KCODER_STUDIO_MAX_CONNECTIONS: String(maxConnections),
      KCODER_STUDIO_MAX_BROWSER_CONNECTIONS: String(Math.min(maxConnections, 4)),
      KCODER_STUDIO_MOCK: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', error => { stderr += `${error.name}\n` })
  let base
  try {
    base = await waitFor(() => stdout.match(/KCoder Studio: (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
      timeoutMs: 5_000,
      message: 'Gateway did not print its loopback listener address',
    })
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve))
      child.kill('SIGTERM')
      await Promise.race([closed, pause(2_000)])
    }
    rmSync(state, { recursive: true, force: true })
    const safeStdout = stdout.replace(/([?&]token=)[^&\s]+/g, '$1<redacted>').slice(-500)
    throw new Error(`${error.message}; stdout=${JSON.stringify(safeStdout)}; stderr=${JSON.stringify(stderr.slice(-1_000))}`)
  }
  const sessionResponse = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'isolated-handshake-test-token' }),
  })
  assert.equal(sessionResponse.status, 200, 'isolated Gateway should issue a bounded mobile session')
  const session = await sessionResponse.json()
  const port = Number(new URL(base).port)
  let stopPromise

  return {
    state,
    child,
    base,
    port,
    rpcToken: session.rpcToken,
    accessToken: session.accessToken,
    workspaceA,
    workspaceB,
    delayFile,
    tracePath,
    get stderr() { return stderr },
    connect(serverId, workspace) {
      return createGatewaySocket({ port, rpcToken: session.rpcToken, accessToken: session.accessToken, serverId, workspace, socketWaitMs })
    },
    async setADelay(delayMs) {
      writeFileSync(delayFile, JSON.stringify({ delayMs }))
    },
    readTrace(path) {
      const raw = readFileSync(path, 'utf8').trim()
      return raw ? raw.split('\n').map(line => JSON.parse(line)) : []
    },
    async stop() {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve => child.once('close', resolve))
        child.kill('SIGTERM')
        await Promise.race([closed, pause(5_000).then(() => { throw new Error('owned Gateway process failed to exit') })])
      }
      const traceRows = this.readTrace(tracePath)
      const spawned = new Set(traceRows.filter(row => row.event === 'spawn').map(row => row.pid))
      const exited = new Set(traceRows.filter(row => row.event === 'exit').map(row => row.pid))
      rmSync(state, { recursive: true, force: true })
      return { spawnedChildCount: spawned.size, exitedChildCount: [...spawned].filter(pid => exited.has(pid)).length }
      })()
      return stopPromise
    },
  }
}

async function cleanupRig(rig, sockets) {
  for (const socket of sockets) socket.destroy()
  const cleanup = await rig.stop()
  assert.equal(cleanup.spawnedChildCount, cleanup.exitedChildCount, 'all owned fake app-server children should exit before fixture cleanup')
  return cleanup
}

function initializeParams(clientName = 'workspace-handshake-diagnostic') {
  return {
    protocolVersion: '2026-07-27',
    clientInfo: { name: clientName, version: '1' },
  }
}

async function connectInitialized(rig, serverId, workspace, requestId) {
  const connection = await rig.connect(serverId, workspace)
  assert.equal(connection.status, 101)
  connection.send({ jsonrpc: '2.0', id: requestId, method: 'initialize', params: initializeParams() })
  const response = await connection.waitForMessage(message => message.id === requestId)
  assert.ok(response.result?.capabilities?.experimental?.residentThreads, `workspace ${serverId} should report resident thread support`)
  return { connection, response }
}

async function beginRawUpgrade(rig, workspace, includeKey = true) {
  const socket = createConnection({ host: '127.0.0.1', port: rig.port })
  socket.on('error', () => {})
  const closed = new Promise(resolve => socket.once('close', resolve))
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const path = `/rpc?token=${encodeURIComponent(rig.rpcToken)}&server=workspace-target&workspace=${encodeURIComponent(workspace)}`
  socket.write([
    `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${rig.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    ...(includeKey ? ['Sec-WebSocket-Key: d29ya3NwYWNlLWhhbmRzaGFrZS1yZXBybw=='] : []),
    'Sec-WebSocket-Version: 13', `Origin: http://127.0.0.1:${rig.port}`,
    `Authorization: Bearer ${rig.accessToken}`, '', '',
  ].join('\r\n'))
  return { socket, closed }
}

test('an upgrade without a WebSocket key does not start an app-server', { skip: confirm12sTimeoutOnly }, async t => {
  const rig = await makeRig('missing-websocket-key')
  const sockets = new Set()
  t.after(() => cleanupRig(rig, sockets))
  const rejected = await beginRawUpgrade(rig, rig.workspaceA, false)
  await Promise.race([rejected.closed, pause(2_000).then(() => { throw new Error('invalid upgrade did not close') })])
  await pause(150)
  assert.equal(rig.readTrace(rig.tracePath).filter(row => row.event === 'spawn').length, 0)
})

test('disconnect while waiting for idle shutdown does not consume a connection or spawn a broker', { skip: confirm12sTimeoutOnly }, async t => {
  const rig = await makeRig('abandoned-upgrade', { idleMs: 50, maxConnections: 1, idleLifecycle: true, shutdownDelayMs: 1_000 })
  const sockets = new Set()
  t.after(() => cleanupRig(rig, sockets))
  const { connection: first } = await connectInitialized(rig, 'workspace-target', rig.workspaceA, 601)
  sockets.add(first)
  first.destroy()
  await first.closed
  await waitFor(() => rig.readTrace(rig.tracePath).some(row => row.event === 'idle-shutdown'), { timeoutMs: 5_000, message: 'owned broker did not begin idle shutdown' })
  const abandoned = await beginRawUpgrade(rig, rig.workspaceA)
  await pause(100)
  abandoned.socket.destroy()
  await abandoned.closed
  const halfClosed = await beginRawUpgrade(rig, rig.workspaceA)
  await pause(100)
  halfClosed.socket.end()
  await Promise.race([halfClosed.closed, pause(3_000).then(() => { throw new Error('half-closed upgrade did not close') })])
  await waitFor(() => rig.readTrace(rig.tracePath).some(row => row.event === 'exit'), { timeoutMs: 5_000, message: 'owned broker did not exit' })
  await pause(200)
  assert.equal(rig.readTrace(rig.tracePath).filter(row => row.event === 'spawn').length, 1, 'abandoned upgrade must not start a replacement broker')
  const { connection: recovered } = await connectInitialized(rig, 'workspace-target', rig.workspaceA, 602)
  sockets.add(recovered)
})

test('concurrent upgrades waiting for idle shutdown respect the connection limit', { skip: confirm12sTimeoutOnly }, async t => {
  const rig = await makeRig('concurrent-upgrades', { idleMs: 50, maxConnections: 1, idleLifecycle: true, shutdownDelayMs: 1_000, socketWaitMs: 5_000 })
  const sockets = new Set()
  t.after(() => cleanupRig(rig, sockets))
  const { connection: first } = await connectInitialized(rig, 'workspace-target', rig.workspaceA, 701)
  sockets.add(first)
  first.destroy()
  await first.closed
  await waitFor(() => rig.readTrace(rig.tracePath).some(row => row.event === 'idle-shutdown'), { timeoutMs: 5_000 })
  const results = await Promise.all([
    rig.connect('workspace-target', rig.workspaceA),
    rig.connect('workspace-target', rig.workspaceA),
  ])
  for (const result of results) sockets.add(result)
  assert.equal(results.filter(result => result.status === 101).length, 1)
  assert.equal(results.filter(result => result.status === null).length, 1)
  await pause(150)
  assert.equal(rig.readTrace(rig.tracePath).filter(row => row.event === 'spawn').length, 2, 'the refused upgrade must not spawn an extra broker')
})

test('an uninitialized client cannot block another authenticated workspace handshake', async t => {
  const rig = await makeRig('live-client')
  const sockets = new Set()
  t.after(() => cleanupRig(rig, sockets))

  const firstA = await rig.connect('workspace-target', rig.workspaceA)
  assert.equal(firstA.status, 101)
  sockets.add(firstA)
  const secondA = await rig.connect('workspace-target', rig.workspaceA)
  assert.equal(secondA.status, 101, 'a cold client must receive its own exclusive broker without waiting for another client to initialize')
  sockets.add(secondA)
  const firstB = await rig.connect('workspace-target', rig.workspaceB)
  assert.equal(firstB.status, 101)
  sockets.add(firstB)
  for (const [connection, id, name] of [[secondA, 11, 'independent-A'], [firstB, 12, 'workspace-B']]) {
    connection.send({ jsonrpc: '2.0', id, method: 'initialize', params: initializeParams(name) })
    const response = await connection.waitForMessage(message => message.id === id)
    assert.ok(response.result?.capabilities?.experimental?.residentThreads)
  }
  const before = rig.readTrace(rig.tracePath).filter(row => row.event === 'spawn')
  assert.equal(before.filter(row => row.workspace === rig.workspaceA).length, 2, 'unknown backends remain exclusive until capability negotiation')

  await rig.setADelay(750)
  const delayedStarted = Date.now()
  firstA.send({ jsonrpc: '2.0', id: 21, method: 'initialize', params: initializeParams('delayed-A') })
  const reused = await rig.connect('workspace-target', rig.workspaceA)
  assert.equal(reused.status, 101, 'the already negotiated resident broker remains reusable while the first client initializes')
  sockets.add(reused)
  reused.send({ jsonrpc: '2.0', id: 22, method: 'initialize', params: initializeParams('reused-A') })
  assert.ok((await reused.waitForMessage(message => message.id === 22)).result?.capabilities?.experimental?.residentThreads)
  const firstResponse = await firstA.waitForMessage(message => message.id === 21, 2_000)
  assert.ok(firstResponse.result?.capabilities?.experimental?.residentThreads)
  assert.ok(Date.now() - delayedStarted >= 700, 'the original client retains its actual delayed initialization')
  assert.equal(rig.readTrace(rig.tracePath).filter(row => row.event === 'spawn').length, before.length, 'known resident capabilities enable reuse without another process')
  const cleanup = await cleanupRig(rig, sockets)
  console.log(JSON.stringify({ diagnostic:'workspace-handshake-independent-cold-clients', firstA:firstA.status,
    secondA:secondA.status, firstB:firstB.status, residentReuse:reused.status, cleanup }))
})

test('disconnecting an uninitialized first A client allows the next A upgrade and initialize immediately', { skip: confirm12sTimeoutOnly }, async t => {
  const rig = await makeRig('disconnect-recovery')
  const sockets = new Set()
  t.after(() => cleanupRig(rig, sockets))

  const firstA = await rig.connect('workspace-target', rig.workspaceA)
  assert.equal(firstA.status, 101)
  sockets.add(firstA)
  firstA.destroy()
  await Promise.race([firstA.closed, pause(1_000).then(() => { throw new Error('first A socket did not close') })])

  const recovered = await connectInitialized(rig, 'workspace-target', rig.workspaceA, 41)
  sockets.add(recovered.connection)
  assert.ok(recovered.connection.elapsedMs < handshakeTimeoutMs, `clientless unknown broker should be directly reusable, observed ${recovered.connection.elapsedMs}ms`)
  const cleanup = await cleanupRig(rig, sockets)
  console.log(JSON.stringify({
    diagnostic: 'workspace-handshake-disconnect-recovery',
    targetId: 'workspace-target',
    firstA: { httpStatus: firstA.status, initializeSent: false, disconnected: true },
    nextA: { httpStatus: recovered.connection.status, elapsedMs: recovered.connection.elapsedMs, initialize: 'residentThreads' },
    gatewayHealthTimeoutMs: handshakeTimeoutMs,
    cleanup,
  }))
})

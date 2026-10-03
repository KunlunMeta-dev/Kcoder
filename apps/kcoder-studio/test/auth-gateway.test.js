import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const studioRoot = fileURLToPath(new URL('..', import.meta.url))

async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server.close()
  await once(server, 'close')
  return port
}

function launch(env) {
  return spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForServer(child) {
  let output = ''
  child.stdout.setEncoding('utf8')
  for await (const chunk of child.stdout) {
    output += chunk
    const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/)
    if (match) return match[1]
  }
  throw new Error(`gateway exited before startup: ${output}`)
}

test('supports an OS-assigned loopback port for desktop hosts', async t => {
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: 'desktop-token',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  const base = await waitForServer(child)
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.notEqual(new URL(base).port, '0')

  const accepted = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'desktop-token' }),
  })
  assert.equal(accepted.status, 303)
  assert.match(accepted.headers.get('set-cookie') ?? '', /kcoder_studio_session=/)
})

test('serves Expo static and dynamic route HTML before the SPA fallback', async t => {
  const webRoot = await mkdtemp(join(tmpdir(), 'kcoder-studio-static-routes-'))
  t.after(() => rm(webRoot, { recursive: true, force: true }))
  await mkdir(join(webRoot, 'h', '[profileId]', 'task', '[serverId]'), { recursive: true })
  const html = marker => `<html><head></head><body>${marker}</body></html>`
  await Promise.all([
    writeFile(join(webRoot, 'index.html'), html('ROOT_SPA')),
    writeFile(join(webRoot, 'open-project.html'), html('OPEN_PROJECT_SSR')),
    writeFile(join(webRoot, 'h', '[profileId]', 'index.html'), html('PROFILE_SSR')),
    writeFile(join(webRoot, 'h', '[profileId]', 'task', '[serverId]', '[threadId].html'), html('TASK_SSR')),
  ])
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_WEB_ROOT: webRoot,
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  const base = await waitForServer(child)

  const mobileSession = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '123' }),
  })
  assert.equal(mobileSession.status, 200, '无鉴权 Gateway 应忽略客户端保留的默认测试 token')

  assert.match(await (await fetch(`${base}/open-project?profileId=profile-a`)).text(), /OPEN_PROJECT_SSR/)
  assert.match(await (await fetch(`${base}/h/profile-a`)).text(), /PROFILE_SSR/)
  assert.match(await (await fetch(`${base}/h/127.0.0.1:4173-profile-a`)).text(), /PROFILE_SSR/)
  assert.match(await (await fetch(`${base}/h/profile-a/task/local/thread-1`)).text(), /TASK_SSR/)
  assert.match(await (await fetch(`${base}/unknown-client-route`)).text(), /ROOT_SPA/)
})

async function websocketStatus({
  port,
  cookie = '',
  bearer = '',
  protocolSession = '',
  origin,
  authority = `127.0.0.1:${port}`,
}) {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const headers = [
    'GET /rpc?token=cookie-auth&server=local HTTP/1.1',
    `Host: ${authority}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGVzdC13ZWJzb2NrZXQta2V5',
    'Sec-WebSocket-Version: 13',
    ...(origin ? [`Origin: ${origin}`] : []),
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    ...(bearer ? [`Authorization: Bearer ${bearer}`] : []),
    ...(protocolSession ? [`Sec-WebSocket-Protocol: kcoder-studio, kcoder-session.${protocolSession}`] : []),
    '',
    '',
  ]
  socket.write(headers.join('\r\n'))
  return new Promise(resolve => {
    let response = ''
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000, () => finish(null))
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
      const match = response.match(/^HTTP\/1\.1 (\d+)/)
      if (match) finish(Number(match[1]))
    })
    socket.on('close', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

async function rawHttp({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

async function websocketUpgradeWithFirstFrame({ port, cookie }) {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const headers = Buffer.from([
    'GET /rpc?token=cookie-auth&server=local HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGVzdC13ZWJzb2NrZXQta2V5',
    'Sec-WebSocket-Version: 13',
    `Origin: http://127.0.0.1:${port}`,
    `Cookie: ${cookie}`,
    '',
    '',
  ].join('\r\n'))
  const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { padding: '' } }
  while (Buffer.byteLength(JSON.stringify(request)) < 127) request.params.padding += 'x'
  const payload = Buffer.from(JSON.stringify(request))
  assert.equal(payload.length, 127, 'regression frame must exercise the 16-bit length value 127')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  const firstFrame = Buffer.concat([Buffer.from([0x81, 0xfe, 0x00, 0x7f]), mask, masked])
  socket.write(Buffer.concat([headers, firstFrame]))
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0)
    const finish = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(2000, () => reject(new Error('combined upgrade/frame response timed out')))
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk])
      const text = response.toString('utf8')
      if (text.includes('101 Switching Protocols') && text.includes('"id":1') && text.includes('protocolVersion')) finish(true)
    })
    socket.on('error', reject)
  })
}

async function openAuthorizedWebsocket({ port, bearer, serverId = 'local' }) {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  socket.write([
    `GET /rpc?token=cookie-auth&server=${encodeURIComponent(serverId)} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGVzdC13ZWJzb2NrZXQta2V5',
    'Sec-WebSocket-Version: 13',
    `Authorization: Bearer ${bearer}`,
    '',
    '',
  ].join('\r\n'))
  let response = ''
  while (!response.includes('\r\n\r\n')) {
    response += String((await once(socket, 'data'))[0])
  }
  assert.match(response, /^HTTP\/1\.1 101/)
  return socket
}

function clientTextFrame(message) {
  const payload = Buffer.from(JSON.stringify(message))
  assert.ok(payload.length < 126, 'test frame helper only supports short JSON payloads')
  const mask = Buffer.from([0x31, 0x42, 0x53, 0x64])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
}

test('mobile clients can exchange the access token for a bearer session', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'mobile-token',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`

  const rejected = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  })
  assert.equal(rejected.status, 401)

  const accepted = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'mobile-token' }),
  })
  assert.equal(accepted.status, 200)
  const mobileCookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  assert.match(mobileCookie, /^kcoder_studio_session=/)
  const session = await accepted.json()
  assert.equal(session.rpcToken, 'cookie-auth')
  assert.equal(typeof session.accessToken, 'string')
  assert.ok(session.accessToken.length >= 32)
  assert.ok(session.expiresAt > Date.now())

  const headers = { authorization: `Bearer ${session.accessToken}` }
  const servers = await fetch(`${base}/api/servers`, { headers })
  assert.equal(servers.status, 200)
  assert.deepEqual((await servers.json()).servers.map(server => server.id), ['local'])
  assert.equal(await websocketStatus({ port, bearer: session.accessToken }), 101)
  assert.equal(
    await websocketStatus({
      port,
      cookie: mobileCookie,
      origin: `http://127.0.0.1:${port}`,
    }),
    101
  )
  assert.equal(await websocketUpgradeWithFirstFrame({ port, cookie: mobileCookie }), true)
  assert.equal(await websocketStatus({ port, bearer: 'invalid-session' }), null)

  const activeSocket = await openAuthorizedWebsocket({ port, bearer: session.accessToken })
  const activeSocketClosed = once(activeSocket, 'close')

  const logout = await fetch(`${base}/api/mobile/session`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(logout.status, 204)
  await activeSocketClosed
  assert.equal((await fetch(`${base}/api/servers`, { headers })).status, 401)
  assert.equal(await websocketStatus({ port, bearer: session.accessToken }), null)
})

test('authenticated same-origin clients are not filtered by hostname or IP', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'unlisted-host-token',
    KCODER_STUDIO_ALLOWED_HOSTS: '127.0.0.1',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const authority = `127.0.0.1:${port}`
  const origin = `http://${authority}`

  const accepted = await rawHttp({
    port,
    method: 'POST',
    path: '/api/mobile/session',
    headers: { host: authority, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'unlisted-host-token' }),
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.headers['access-control-allow-origin'], origin)
  const session = JSON.parse(accepted.body)
  assert.equal(await websocketStatus({ port, bearer: session.accessToken, authority, origin }), 101)

  const crossOrigin = await rawHttp({
    port,
    method: 'POST',
    path: '/api/mobile/session',
    headers: { host: authority, origin: `http://other.example:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'unlisted-host-token' }),
  })
  assert.equal(crossOrigin.status, 403)
})

test('removing a same-origin mobile profile preserves the authenticated web host session', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'host-and-mobile-token',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'host-and-mobile-token' }),
  })
  const hostCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  assert.match(hostCookie, /^kcoder_studio_session=/)

  const exchange = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { cookie: hostCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'host-and-mobile-token' }),
  })
  assert.equal(exchange.status, 200)
  assert.equal(exchange.headers.get('set-cookie'), null, '移动会话不得覆盖已有网页登录 cookie')
  const mobileSession = await exchange.json()

  const removal = await fetch(`${base}/api/mobile/session`, {
    method: 'DELETE',
    headers: { cookie: hostCookie, authorization: `Bearer ${mobileSession.accessToken}` },
  })
  assert.equal(removal.status, 204)
  assert.equal(removal.headers.get('set-cookie'), null, '删除 bearer profile 不得清除另一个网页登录 cookie')
  assert.equal((await fetch(base, { headers: { cookie: hostCookie } })).status, 200)
})

test('an explicitly trusted Mobile Web origin can use bearer APIs and a session-bound websocket', async t => {
  const port = await unusedPort()
  const trustedOrigin = 'http://127.0.0.1:43199'
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'cross-origin-mobile-token',
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: trustedOrigin,
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`

  const preflight = await fetch(`${base}/api/mobile/session`, {
    method: 'OPTIONS',
    headers: {
      origin: trustedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), trustedOrigin)
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/)
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Content-Type/i)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)

  const accepted = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { origin: trustedOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'cross-origin-mobile-token' }),
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.headers.get('access-control-allow-origin'), trustedOrigin)
  const session = await accepted.json()

  const serversPreflight = await fetch(`${base}/api/servers`, {
    method: 'OPTIONS',
    headers: {
      origin: trustedOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  })
  assert.equal(serversPreflight.status, 204)
  const servers = await fetch(`${base}/api/servers`, {
    headers: { origin: trustedOrigin, authorization: `Bearer ${session.accessToken}` },
  })
  assert.equal(servers.status, 200)
  assert.equal(servers.headers.get('access-control-allow-origin'), trustedOrigin)
  assert.deepEqual((await servers.json()).servers.map(server => server.id), ['local'])
  assert.equal(await websocketStatus({ port, origin: trustedOrigin, protocolSession: session.accessToken }), 101)

  const rejectedOrigin = 'http://127.0.0.1:43200'
  const rejected = await fetch(`${base}/api/mobile/session`, {
    method: 'OPTIONS',
    headers: { origin: rejectedOrigin, 'access-control-request-method': 'POST' },
  })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.headers.get('access-control-allow-origin'), null)
  assert.equal(await websocketStatus({ port, origin: rejectedOrigin, protocolSession: session.accessToken }), null)
})

test('an active websocket is closed when its mobile session expires', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'short-lived-token',
    KCODER_STUDIO_AUTH_SESSION_TTL_MS: '1200',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const accepted = await fetch(`http://127.0.0.1:${port}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'short-lived-token' }),
  })
  const session = await accepted.json()
  const socket = await openAuthorizedWebsocket({ port, bearer: session.accessToken })
  await Promise.race([
    once(socket, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('expired websocket stayed open')), 4000)),
  ])
})

test('fails closed when an all-interface listener has no explicit auth configuration', async () => {
  const child = launch({
    KCODER_STUDIO_HOST: '0.0.0.0',
    KCODER_STUDIO_AUTH_TOKEN: '',
    KCODER_STUDIO_ALLOWED_HOSTS: '',
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  assert.match(stderr, /AUTH_TOKEN is required/)
})

test('mock websocket failures are isolated to the connection', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'mock-isolation-token',
    KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'mock-isolation-token' }),
  })
  assert.equal(accepted.status, 200)
  const session = await accepted.json()
  const headers = { authorization: `Bearer ${session.accessToken}` }

  const resetSocket = await openAuthorizedWebsocket({ port, bearer: session.accessToken })
  resetSocket.on('error', () => {})
  resetSocket.resetAndDestroy()
  await new Promise(resolveWait => setTimeout(resolveWait, 50))
  assert.equal((await fetch(`${base}/api/servers`, { headers })).status, 200,
    'TCP reset must not terminate the mock Gateway')

  const malformedSocket = await openAuthorizedWebsocket({ port, bearer: session.accessToken })
  malformedSocket.on('error', () => {})
  const malformedClosed = once(malformedSocket, 'close')
  malformedSocket.write(Buffer.from([0x81, 0x01, 0x7b]))
  await malformedClosed
  assert.equal((await fetch(`${base}/api/servers`, { headers })).status, 200,
    'malformed WebSocket frame must only close its own connection')
  assert.equal(child.exitCode, null)
})

test('exchanges the static login token for an HttpOnly session cookie', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_PUBLIC_ORIGINS: 'https://studio.example',
  })
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`

  const anonymous = await fetch(`${base}/`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  })
  assert.equal(anonymous.status, 303)
  assert.equal(anonymous.headers.get('location'), '/login')
  const deepLink = await fetch(`${base}/settings/kcoder-servers?from=expired`, {
    redirect: 'manual', headers: { accept: 'text/html' },
  })
  assert.equal(deepLink.headers.get('location'), '/login?returnTo=%2Fsettings%2Fkcoder-servers%3Ffrom%3Dexpired')
  const loginPage = await fetch(`${base}/login`)
  assert.match(loginPage.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  assert.match(loginPage.headers.get('content-security-policy') ?? '', /object-src 'none'/)
  const rejected = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'wrong-token' }),
  })
  assert.equal(rejected.status, 401)
  assert.match(rejected.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  assert.equal(rejected.headers.get('x-content-type-options'), 'nosniff')

  const returnLogin = await fetch(`${base}/login?returnTo=${encodeURIComponent('/settings/kcoder-servers?from=expired')}`)
  assert.match(await returnLogin.text(), /name="returnTo"[^>]+value="\/settings\/kcoder-servers\?from=expired"/)
  const returned = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token', returnTo: '/settings/kcoder-servers?from=expired' }),
  })
  assert.equal(returned.headers.get('location'), '/settings/kcoder-servers?from=expired')
  const openRedirect = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token', returnTo: '//evil.example' }),
  })
  assert.equal(openRedirect.headers.get('location'), '/')

  const accepted = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  assert.equal(accepted.status, 303)
  const setCookie = accepted.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /kcoder_studio_session=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';', 1)[0]
  const authenticatedDeepLink = await fetch(`${base}/settings/kcoder-servers`, {
    headers: { cookie, accept: 'text/html' },
  })
  assert.equal(authenticatedDeepLink.status, 200)
  assert.match(await authenticatedDeepLink.text(), /name="kcoder-rpc-token"/)
  const unknownApi = await fetch(`${base}/api/not-a-real-endpoint`, {
    headers: { cookie, accept: 'application/json' },
  })
  assert.equal(unknownApi.status, 404)
  assert.match(unknownApi.headers.get('content-type') ?? '', /application\/json/)
  const servers = await fetch(`${base}/api/servers`, { headers: { cookie } })
  assert.equal(servers.status, 200)
  assert.ok(Array.isArray((await servers.json()).servers))
  const statuses = await fetch(`${base}/api/servers/status`, { headers: { cookie } }).then(value => value.json())
  assert.deepEqual(statuses.statuses.map(item => ({ id: item.id, status: item.status })), [
    { id: 'local', status: 'online' },
  ])
  const renderer = await fetch(`${base}/`, { headers: { cookie } })
  const rendererCsp = renderer.headers.get('content-security-policy') ?? ''
  assert.match(rendererCsp, /frame-ancestors 'none'/)
  assert.match(rendererCsp, /sha256-67fhrP0\+BkBqmgGGXTtgiVO\/9EQs3QruYNU\/7fnRkI8=/)
  assert.doesNotMatch(rendererCsp, /script-src[^;]*'unsafe-inline'/)
  assert.equal(
    await websocketStatus({ port, cookie, origin: `http://127.0.0.1:${port}` }),
    101
  )
  assert.equal(
    await websocketStatus({ port, origin: `http://127.0.0.1:${port}` }),
    null
  )
  assert.equal(await websocketStatus({ port, cookie, origin: 'http://evil.example' }), null)
  assert.equal(
    await websocketStatus({
      port,
      cookie,
      origin: 'https://studio.example',
      authority: 'studio.example',
    }),
    101
  )
  assert.equal(
    await websocketStatus({
      port,
      cookie: 'kcoder_studio_session=%',
      origin: `http://127.0.0.1:${port}`,
    }),
    null
  )
  assert.equal((await fetch(`${base}/login`)).status, 200)
  const logout = await fetch(`${base}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
  })
  assert.equal(logout.status, 303)
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
  const revoked = await fetch(`${base}/api/servers`, { headers: { cookie } })
  assert.equal(revoked.status, 401)
})

test('authenticated same-origin clients can persist and remove SSH targets', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-servers-'))
  const store = join(dataDir, 'servers.json')
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const headers = {
    cookie,
    origin: base,
    'content-type': 'application/json',
  }

  const unknownApi = await fetch(`${base}/api/servers/bad%20id!`, {
    method: 'PUT', headers, body: '{}',
  })
  assert.equal(unknownApi.status, 404)
  assert.match(unknownApi.headers.get('content-type') ?? '', /application\/json/)

  const rejectedCsrf = await fetch(`${base}/api/servers/gpu-01`, {
    method: 'PUT', headers: { ...headers, origin: 'http://evil.example' }, body: '{}',
  })
  assert.equal(rejectedCsrf.status, 403)

  const saved = await fetch(`${base}/api/servers/gpu-01`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      id: 'gpu-01', label: 'GPU 服务器', transport: 'ssh', host: '100.64.0.21',
      user: 'devuser', port: 2222, workspace: '/data/project', acceptNewHostKey: true,
      profile: 'minimax', settingsFile: '/srv/settings.json', chromiumBin: '/usr/bin/chromium',
      chromiumNoSandbox: true,
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).server.host, '100.64.0.21')
  const listed = await fetch(`${base}/api/servers`, { headers: { cookie } }).then(value => value.json())
  assert.deepEqual(listed.servers.map(server => server.id), ['local', 'gpu-01'])
  const persisted = JSON.parse(await readFile(store, 'utf8'))
  assert.equal(persisted[1].workspace, '/data/project')
  assert.equal(persisted[1].acceptNewHostKey, true)
  assert.equal(listed.servers[1].settingsFile, '/srv/settings.json')
  const edited = await fetch(`${base}/api/servers/gpu-01`, {
    method: 'PUT', headers,
    body: JSON.stringify({ ...listed.servers[1], label: 'GPU 编辑后', workspace: listed.servers[1].workspacePath }),
  })
  assert.equal(edited.status, 200)
  const editedPersisted = JSON.parse(await readFile(store, 'utf8'))[1]
  assert.equal(editedPersisted.profile, 'minimax')
  assert.equal(editedPersisted.settingsFile, '/srv/settings.json')
  assert.equal(editedPersisted.chromiumBin, '/usr/bin/chromium')
  assert.equal(editedPersisted.chromiumNoSandbox, true)

  const removed = await fetch(`${base}/api/servers/gpu-01`, { method: 'DELETE', headers })
  assert.equal(removed.status, 200)
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).map(server => server.id), ['local'])
  const cannotDeleteLocal = await fetch(`${base}/api/servers/local`, { method: 'DELETE', headers })
  assert.equal(cannotDeleteLocal.status, 400)
})

test('authenticated clients can manage safe local targets without creating workspaces', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-local-targets-'))
  const store = join(dataDir, 'servers.json')
  const workspace = join(dataDir, 'workspace')
  const missingWorkspace = join(dataDir, 'must-not-be-created')
  const fileWorkspace = join(dataDir, 'not-a-directory')
  await mkdir(workspace)
  await writeFile(fileWorkspace, 'file')
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token', KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(() => { if (!child.killed) child.kill('SIGTERM') })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const headers = { cookie, origin: base, 'content-type': 'application/json' }
  const save = (id, path) => fetch(`${base}/api/servers/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({
      id, label: id, runtime: 'kcoder', transport: 'local', workspace: path,
      command: '/usr/bin/kcoder',
    }),
  })

  assert.equal((await save('second-local', workspace)).status, 200)
  const kcoderLocal = await fetch(`${base}/api/servers/kcoder-local`, {
    method: 'PUT', headers, body: JSON.stringify({
      id: 'kcoder-local', label: 'KCoder local', runtime: 'kcoder', transport: 'local', workspace,
      command: '/usr/bin/kcoder', profile: 'minimax', settingsFile: '/tmp/settings.json',
      chromiumBin: '/usr/bin/chromium', chromiumNoSandbox: true,
    }),
  })
  assert.equal(kcoderLocal.status, 200)
  const listed = await fetch(`${base}/api/servers`, { headers: { cookie } }).then(value => value.json())
  assert.equal(listed.servers.find(server => server.id === 'second-local').runtime, 'kcoder')
  const publicKCoder = listed.servers.find(server => server.id === 'kcoder-local')
  const editedKCoder = await fetch(`${base}/api/servers/kcoder-local`, {
    method: 'PUT', headers, body: JSON.stringify({ ...publicKCoder, label: 'KCoder edited', workspace: publicKCoder.workspacePath }),
  })
  assert.equal(editedKCoder.status, 200)
  const persistedKCoder = JSON.parse(await readFile(store, 'utf8')).find(target => target.id === 'kcoder-local')
  assert.equal(persistedKCoder.profile, 'minimax')
  assert.equal(persistedKCoder.settingsFile, '/tmp/settings.json')
  assert.equal(persistedKCoder.chromiumBin, '/usr/bin/chromium')
  assert.equal((await save('missing-local', missingWorkspace)).status, 400)
  assert.equal(await stat(missingWorkspace).then(() => true, () => false), false)
  assert.equal((await save('file-local', fileWorkspace)).status, 400)
  assert.equal((await fetch(`${base}/api/servers/second-local`, { method: 'DELETE', headers })).status, 200)
  assert.equal((await fetch(`${base}/api/servers/kcoder-local`, { method: 'DELETE', headers })).status, 200)
  assert.equal((await fetch(`${base}/api/servers/local`, {
    method: 'PUT', headers, body: JSON.stringify({ id: 'local', label: 'fake', runtime: 'codex', transport: 'local', workspace }),
  })).status, 400)
  assert.equal((await fetch(`${base}/api/servers/removed-codex`, {
    method: 'PUT', headers, body: JSON.stringify({
      id: 'removed-codex', label: 'removed', runtime: 'codex', transport: 'local', workspace,
    }),
  })).status, 400)
})

test('legacy stores migrate on mutation and the final runtime target cannot be deleted', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-legacy-targets-'))
  const store = join(dataDir, 'servers.json')
  const workspace = join(dataDir, 'workspace')
  await mkdir(workspace)
  await writeFile(store, JSON.stringify([{
    id: 'legacy', label: 'Legacy', transport: 'local', workspace, command: '/usr/bin/kcoder',
  }]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token', KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(() => { if (!child.killed) child.kill('SIGTERM') })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const headers = { cookie, origin: base, 'content-type': 'application/json' }
  const added = await fetch(`${base}/api/servers/second`, {
    method: 'PUT', headers, body: JSON.stringify({
      id: 'second', label: 'Second', runtime: 'kcoder', transport: 'local', workspace, command: '/usr/bin/kcoder',
    }),
  })
  assert.equal(added.status, 200)
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).map(target => target.runtime), ['kcoder', 'kcoder'])
  assert.equal((await fetch(`${base}/api/servers/second`, { method: 'DELETE', headers })).status, 200)
  const deleteLast = await fetch(`${base}/api/servers/legacy`, { method: 'DELETE', headers })
  assert.equal(deleteLast.status, 400)
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).map(target => target.id), ['legacy'])
})

test('a missing app-server command fails health quickly and does not wedge gateway shutdown', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-missing-command-'))
  const workspace = join(dataDir, 'workspace')
  const store = join(dataDir, 'servers.json')
  await mkdir(workspace)
  await writeFile(store, JSON.stringify([{
    id: 'missing-kcoder',
    label: 'Missing KCoder',
    runtime: 'kcoder',
    transport: 'local',
    workspace,
    command: join(dataDir, 'does-not-exist'),
  }]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const startedAt = Date.now()
  const response = await fetch(`${base}/api/servers/status`, { headers: { cookie } })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.statuses[0].status, 'offline')
  assert.match(payload.statuses[0].error, /ENOENT|spawn|does-not-exist/)
  assert.ok(Date.now() - startedAt < 3_000)

  child.kill('SIGTERM')
  let shutdownTimer
  try {
    await Promise.race([
      once(child, 'close'),
      new Promise((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error('gateway shutdown timed out')), 3_000)
      }),
    ])
  } finally {
    clearTimeout(shutdownTimer)
  }
})

test('replacing a runtime target closes its active websocket and app-server child', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-replace-target-'))
  const workspace = join(dataDir, 'workspace')
  const store = join(dataDir, 'servers.json')
  const command = join(dataDir, 'long-running-app-server')
  const pidFile = join(dataDir, 'child.pid')
  await mkdir(workspace)
  await writeFile(command, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 })
  const original = { id: 'replace-me', label: 'Original', runtime: 'kcoder', transport: 'local', workspace, command }
  await writeFile(store, JSON.stringify([original]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await rm(dataDir, { recursive: true, force: true })
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'test-token' }),
  }).then(value => value.json())
  const socket = await openAuthorizedWebsocket({ port, bearer: login.accessToken, serverId: 'replace-me' })
  t.after(() => socket.destroy())
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await stat(pidFile).then(() => true, () => false)) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const appServerPid = Number(await readFile(pidFile, 'utf8'))
  const socketClosed = once(socket, 'close')
  const response = await fetch(`${base}/api/servers/replace-me`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${login.accessToken}`, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ ...original, label: 'Updated' }),
  })
  assert.equal(response.status, 200)
  await Promise.race([
    socketClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('replaced target websocket stayed open')), 4000)),
  ])
  assert.equal(await stat(`/proc/${appServerPid}`).then(() => true, () => false), false)
})

test('concurrent first RPC connections share one probing resident app-server', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-resident-singleflight-'))
  const workspace = join(dataDir, 'workspace')
  const store = join(dataDir, 'servers.json')
  const command = join(dataDir, 'resident-app-server')
  const pidFile = join(dataDir, 'children.log')
  await mkdir(workspace)
  await writeFile(command, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'resident-test' }, capabilities: { experimental: { residentThreads: true } } } }) + '\\n');
});
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  await writeFile(store, JSON.stringify([{
    id: 'resident', label: 'Resident', runtime: 'kcoder', transport: 'local', workspace, command,
  }]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_SERVERS_STORE: store,
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await rm(dataDir, { recursive: true, force: true })
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/api/mobile/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-token' }),
  }).then(value => value.json())

  const first = await openAuthorizedWebsocket({ port, bearer: login.accessToken, serverId: 'resident' })
  t.after(() => first.destroy())
  const secondPromise = openAuthorizedWebsocket({ port, bearer: login.accessToken, serverId: 'resident' })
  first.write(clientTextFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
  const second = await secondPromise
  t.after(() => second.destroy())

  const children = (await readFile(pidFile, 'utf8')).trim().split(/\s+/).filter(Boolean)
  assert.equal(new Set(children).size, 1, `expected one probing app-server, got ${children.join(',')}`)
})

test('health timeout escalates to SIGKILL and waits for the stubborn child to close', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-stubborn-command-'))
  const workspace = join(dataDir, 'workspace')
  const store = join(dataDir, 'servers.json')
  const command = join(dataDir, 'stubborn-app-server')
  const pidFile = join(dataDir, 'child.pid')
  await mkdir(workspace)
  await writeFile(command, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 })
  await writeFile(store, JSON.stringify([{
    id: 'stubborn', label: 'Stubborn', runtime: 'kcoder', transport: 'local', workspace, command,
  }]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token',
    KCODER_STUDIO_SERVERS_STORE: store,
    KCODER_STUDIO_HEALTH_TIMEOUT_MS: '100',
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const accepted = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }),
  })
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const startedAt = Date.now()
  const payload = await fetch(`${base}/api/servers/status`, { headers: { cookie } }).then(value => value.json())
  assert.equal(payload.statuses[0].status, 'offline')
  assert.match(payload.statuses[0].error, /timed out after 100ms/)
  assert.ok(Date.now() - startedAt < 3_000)
  const stubbornPid = Number(await readFile(pidFile, 'utf8'))
  assert.equal(await stat(`/proc/${stubbornPid}`).then(() => true, () => false), false)
})

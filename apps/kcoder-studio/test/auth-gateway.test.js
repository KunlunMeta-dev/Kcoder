import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { hasFullGatewayBrowserAuthority, isGatewayBrowserAdminRequest } from '../src/gateway-browser-access.js'

const studioRoot = fileURLToPath(new URL('..', import.meta.url))

test('Gateway browser authority requires an explicit browser admin session covering every target', () => {
  const session = { browserAdmin: true, allowedServerIds: new Set(['local', 'remote']) }
  assert.equal(hasFullGatewayBrowserAuthority(session, ['local', 'remote']), true)
  assert.equal(hasFullGatewayBrowserAuthority(session, ['local', 'remote', 'new-target']), false)
  assert.equal(hasFullGatewayBrowserAuthority({ ...session, browserAdmin: false }, ['local']), false)
  assert.equal(hasFullGatewayBrowserAuthority({ ...session, deviceId: 'paired-device' }, ['local']), false)
  assert.equal(hasFullGatewayBrowserAuthority({ ...session, allowedServerIds: ['local'] }, ['local']), false)
  const request = { headers: {} }
  assert.equal(isGatewayBrowserAdminRequest(request, session, [{ id: 'local' }], false), false)
  assert.equal(isGatewayBrowserAdminRequest({ headers: { authorization: 'Bearer token' } }, session, [{ id: 'local' }], true), false)
  assert.equal(isGatewayBrowserAdminRequest(request, session, [{ id: 'local' }], true), true)
})

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
  // Auth assertions require a static application page, not a previously built dist.
  // Every process gets owned state even when a case does not exercise persistence.
  const state = mkdtempSync(join(tmpdir(), 'kcoder-auth-fixture-'))
  const webRoot = join(state, 'web')
  mkdirSync(webRoot)
  writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body>Owned auth application</body></html>')
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: {
      ...process.env, NODE_ENV: 'test', HOME: state, XDG_CONFIG_HOME: state,
      KCODER_STUDIO_TEST_DISABLE_AUTH: '1',
      KCODER_CONFIG_DIR: join(state, 'profile'),
      KCODER_STUDIO_SERVERS_STORE: join(state, 'servers.json'),
      KCODER_STUDIO_WORKSPACE: state, KCODER_STUDIO_WEB_ROOT: webRoot,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.once('close', () => rmSync(state, { recursive: true, force: true }))
  return child
}

async function waitForServer(child) {
  child.stdout.setEncoding('utf8')
  // Returning from a for-await loop destroys the pipe and can crash the real
  // Gateway with EPIPE on its next diagnostic. Keep owned output draining.
  return new Promise((resolve, reject) => {
    let output = ''
    const cleanup = () => {
      child.stdout.removeListener('data', onData)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      clearTimeout(timer)
      child.stdout.resume()
    }
    const onData = chunk => {
      output = (output + chunk).slice(-65536)
      const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/)
      if (match) { cleanup(); resolve(match[1]) }
    }
    const onExit = () => { cleanup(); reject(new Error(`Gateway exited before startup: ${output}`)) }
    const onError = error => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Gateway startup timed out')) }, 15000)
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function startAccountStatusGateway(t, { addBarrierTarget = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-account-status-scope-'))
  const binDir = join(dataDir, 'bin')
  const store = join(dataDir, 'servers.json')
  const ssh = join(binDir, 'ssh')
  const probeLog = join(dataDir, 'probes.log')
  const barrierRelease = join(dataDir, 'release-status-probe')
  await mkdir(binDir)
  await writeFile(probeLog, '')
  await writeFile(ssh, String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let username;
const identities = {
  alice: { principalId: '0b6cfba4-5f61-4d17-9d92-3d60a1ef2f01', version: '1.2.3', protocol: '2026-07-27' },
  bob: { principalId: '8a2f6d0e-1c3b-4a5f-9e8d-7b6a5c4d3e2f', version: '9.8.7', protocol: '2026-08-31' },
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!username) {
    username = message.username;
    const identity = identities[username];
    if (!identity) process.exit(2);
    process.stdout.write(JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: true,
      username, principalId: identity.principalId, uid: 2001, role: 'user' }) + '\n');
    return;
  }
  if (message.method === 'initialize') {
    const clientName = message.params?.clientInfo?.name ?? '';
    appendFileSync(${JSON.stringify(probeLog)}, 'isolated:' + username + ':' + clientName + '\n');
    const identity = identities[username];
    const delay = 120;
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: identity.protocol, serverInfo: { name: 'account-status-test', version: identity.version }, capabilities: {},
    } }) + '\n'), delay);
  }
}).on('close', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  const servers = [{
    id: 'isolated', label: 'Isolated', runtime: 'kcoder', transport: 'ssh', host: 'unused.example',
    security: { identity: { mode: 'kcoder-account' } },
  }]
  if (addBarrierTarget) {
    servers.push({ id: 'peer', label: 'Peer', runtime: 'kcoder', transport: 'ssh', host: 'peer.example',
      security: { identity: { mode: 'kcoder-account' } } })
    const barrierCommand = join(dataDir, 'barrier-app-server')
    await writeFile(barrierCommand, String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  appendFileSync(${JSON.stringify(probeLog)}, 'barrier:initialize\n');
  const publish = () => {
    if (!existsSync(${JSON.stringify(barrierRelease)})) { setTimeout(publish, 10); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2026-09-30', serverInfo: { name: 'barrier-status-test', version: '3.4.5' }, capabilities: {},
    } }) + '\n');
  };
  publish();
}).on('close', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 })
    servers.push({ id: 'barrier', label: 'Barrier', runtime: 'kcoder', transport: 'local',
      command: barrierCommand, workspace: dataDir })
  }
  await writeFile(store, JSON.stringify(servers))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: 'test-token', KCODER_STUDIO_SERVERS_STORE: store,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'close')
    }
    await rm(dataDir, { recursive: true, force: true })
  })
  const base = await waitForServer(child)
  const createMobileSession = async () => {
    const response = await fetch(`${base}/api/mobile/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-token' }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const loginAs = async (accessToken, username, targetId = 'isolated') => {
    const response = await fetch(`${base}/api/servers/${targetId}/account`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: `test-${username}-password` }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.deepEqual({ authenticated: payload.authenticated, username: payload.identity?.username },
      { authenticated: true, username })
  }
  const readStatus = async accessToken => {
    const response = await fetch(`${base}/api/servers/status`, { headers: { authorization: `Bearer ${accessToken}` } })
    assert.equal(response.status, 200)
    return response.json()
  }
  const logout = async (accessToken, targetId = 'isolated') => {
    const response = await fetch(`${base}/api/servers/${targetId}/account`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}`, origin: base, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const waitForStatusProbe = async (username, occurrence = 2, targetId = 'isolated') => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const contents = await readFile(probeLog, 'utf8').catch(() => '')
      const count = contents.split('\n').filter(line => line === `${targetId}:${username}:kcoder-studio-connection-test`).length
      if (count >= occurrence) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const contents = await readFile(probeLog, 'utf8').catch(() => '<no app-server initialize seen>')
    throw new Error(`Timed out waiting for ${targetId}/${username} status probe ${occurrence}; log=${contents}`)
  }
  const waitForBarrierProbe = async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const contents = await readFile(probeLog, 'utf8').catch(() => '')
      if (contents.split('\n').includes('barrier:initialize')) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const contents = await readFile(probeLog, 'utf8').catch(() => '<no app-server process exit seen>')
    throw new Error(`Timed out waiting for held barrier status probe; log=${contents}`)
  }
  const releaseBarrierProbe = () => writeFile(barrierRelease, '', { flag: 'wx' })
  return { base, createMobileSession, loginAs, logout, readStatus, waitForStatusProbe, waitForBarrierProbe, releaseBarrierProbe }
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

test('browser login links exchange the Gateway token for a clean, scoped HttpOnly cookie', async t => {
  const port = 0
  const webRoot = await mkdtemp(join(tmpdir(), 'kcoder-public-browser-access-'))
  t.after(() => rm(webRoot, { recursive: true, force: true }))
  await writeFile(join(webRoot, 'index.html'), '<html><head><link href="/assets/app.css"><script src="/assets/app.js"></script></head><body>Gateway</body></html>')
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'browser-link-secret', KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_PUBLIC_ORIGINS: 'https://relay.example',
    KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://relay.example/g/gateway-one',
    KCODER_STUDIO_WEB_ROOT: webRoot,
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  const base = await waitForServer(child)
  const accepted = await fetch(`${base}/login?token=browser-link-secret&returnTo=%2F`, { redirect: 'manual' })
  assert.equal(accepted.status, 303)
  assert.equal(accepted.headers.get('location'), '/')
  assert.match(accepted.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict; Path=\//)
  assert.equal(accepted.headers.get('referrer-policy'), 'no-referrer')
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const page = await fetch(base, { headers: { cookie, accept: 'text/html' } })
  assert.equal(page.status, 200)
  const accessInfo = await fetch(`${base}/api/gateway/browser-access`, { headers: { cookie } })
  assert.equal(accessInfo.status, 200)
  assert.equal(accessInfo.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await accessInfo.json(), {
    token: 'browser-link-secret',
    localBaseUrl: base,
    publicBaseUrl: 'https://relay.example/g/gateway-one',
  })

  const publicLogin = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(new URL(base).port), path: '/login?token=browser-link-secret&returnTo=%2Fg%2Fgateway-one%2F', headers: { host: 'relay.example' } }, response => {
      response.resume()
      response.on('end', () => resolve(response))
    })
    request.once('error', reject)
    request.end()
  })
  assert.equal(publicLogin.statusCode, 303)
  assert.equal(publicLogin.headers.location, '/g/gateway-one/')
  const publicCookie = Array.isArray(publicLogin.headers['set-cookie']) ? publicLogin.headers['set-cookie'][0] : publicLogin.headers['set-cookie']
  assert.match(publicCookie, /^__Host-kcoder_studio_session=/)
  assert.match(publicCookie, /; Path=\/;/)
  assert.match(publicCookie, /; Secure/)
  const publicHome = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(new URL(base).port), path: '/', headers: { host: 'relay.example', cookie: publicCookie.split(';', 1)[0], accept: 'text/html' } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.end()
  })
  assert.equal(publicHome.statusCode, 200)
  assert.match(publicHome.body, /name="kcoder-app-base-path" content="\/g\/gateway-one"/)
  assert.match(publicHome.body, /href="\/g\/gateway-one\/assets\/app\.css"/)
  assert.match(publicHome.body, /src="\/g\/gateway-one\/assets\/app\.js"/)

  const invalid = await fetch(`${base}/login?token=wrong-secret`, { redirect: 'manual' })
  assert.equal(invalid.status, 303)
  assert.equal(invalid.headers.get('location'), '/login?linkError=1')
  assert.doesNotMatch(invalid.headers.get('location') ?? '', /wrong-secret/)
})

test('browser admin access stays separate from Mobile Web cookie and bearer sessions', async t => {
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: 'browser-admin-secret', KCODER_STUDIO_MOCK: '1',
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  const base = await waitForServer(child)

  assert.equal((await fetch(`${base}/login`)).status, 200, 'the ordinary login form remains available')
  const login = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'browser-admin-secret' }),
  })
  assert.equal(login.status, 303)
  const browserCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  assert.match(browserCookie, /^kcoder_studio_session=/)
  assert.equal((await fetch(`${base}/api/gateway/browser-access`, { headers: { cookie: browserCookie } })).status, 200)

  const renewal = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: browserCookie },
    body: new URLSearchParams({ token: 'browser-admin-secret', renewSession: '1' }),
  })
  assert.equal(renewal.status, 303, 'an existing browser admin session can be renewed')
  const renewedCookie = (renewal.headers.get('set-cookie') ?? '').split(';', 1)[0]
  assert.equal(renewedCookie, browserCookie)
  assert.equal((await fetch(`${base}/api/gateway/browser-access`, { headers: { cookie: renewedCookie } })).status, 200)

  const mobileLogin = await fetch(`${base}/api/mobile/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'browser-admin-secret' }),
  })
  assert.equal(mobileLogin.status, 200)
  const mobileSession = await mobileLogin.json()
  const mobileCookie = (mobileLogin.headers.get('set-cookie') ?? '').split(';', 1)[0]
  assert.match(mobileCookie, /^kcoder_studio_session=/)
  assert.equal(mobileSession.accessToken, mobileCookie.slice('kcoder_studio_session='.length))

  const mobileCookieAccess = await fetch(`${base}/api/gateway/browser-access`, { headers: { cookie: mobileCookie } })
  assert.equal(mobileCookieAccess.status, 403, 'a Mobile Web cookie cannot retrieve the Gateway token')
  assert.equal(mobileCookieAccess.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(`${base}/api/mobile/pairing`, { headers: { cookie: mobileCookie } })).status, 403)
  const mobileBearer = { authorization: `Bearer ${mobileSession.accessToken}` }
  assert.equal((await fetch(`${base}/api/gateway/browser-access`, { headers: mobileBearer })).status, 403)
  assert.equal((await fetch(`${base}/api/mobile/pairing`, { headers: mobileBearer })).status, 403)

  const attemptedPromotion = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: mobileCookie },
    body: new URLSearchParams({ token: 'browser-admin-secret', renewSession: '1' }),
  })
  assert.equal(attemptedPromotion.status, 303)
  assert.notEqual((attemptedPromotion.headers.get('set-cookie') ?? '').split(';', 1)[0], mobileCookie)
  assert.equal((await fetch(`${base}/api/gateway/browser-access`, { headers: { cookie: mobileCookie } })).status, 403,
    'renewSession never promotes the original Mobile Web session into browser admin')
})

test('valid SSH-forwarded loopback login links trust only that tunnel authority', async t => {
  const port = 0
  const child = launch({ KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(port), KCODER_STUDIO_AUTH_TOKEN: 'tunnel-secret', KCODER_STUDIO_MOCK: '1' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  const base = new URL(await waitForServer(child))
  const actualPort = Number(base.port)
  const tunnelRequest = (path, cookie = '') => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: actualPort, path, headers: { host: 'localhost:19000', accept: 'text/html', ...(cookie ? { cookie } : {}) } }, response => {
      response.resume()
      response.on('end', () => resolve(response))
    })
    request.once('error', reject)
    request.end()
  })
  const before = await tunnelRequest('/')
  assert.equal(before.statusCode, 421)
  const login = await tunnelRequest('/login?token=tunnel-secret')
  assert.equal(login.statusCode, 303)
  assert.equal(login.headers.location, '/')
  const setCookie = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'] ?? ''
  const cookie = setCookie.split(';', 1)[0]
  const after = await tunnelRequest('/', cookie)
  assert.equal(after.statusCode, 200)
})

test('startup persists a fresh link across Gateway restarts in the selected user home', async t => {
  const home = await mkdtemp(join(tmpdir(), 'kcoder-login-url-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const urlFile = join(home, 'studio-login-url.txt')
  const start = () => launch({
    HOME: home, USERPROFILE: home,
    KCODER_STUDIO_SERVERS_STORE: join(home, 'servers.json'),
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: '', KCODER_STUDIO_TEST_DISABLE_AUTH: '', KCODER_STUDIO_MOCK: '1',
  })
  const readSaved = async previousUrl => {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const contents = await readFile(urlFile, 'utf8')
        const token = new URL(contents.trim()).searchParams.get('token')
        if (token && (!previousUrl || contents.trim() !== previousUrl)) return contents
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Gateway did not persist its login URL')
  }
  const first = start()
  t.after(() => { if (first.exitCode === null && first.signalCode === null) first.kill('SIGTERM') })
  const firstBase = await waitForServer(first)
  const firstUrl = (await readSaved()).trim()
  assert.equal(new URL(firstUrl).origin, firstBase)
  const firstToken = new URL(firstUrl).searchParams.get('token')
  assert.ok(firstToken)
  assert.equal((await stat(urlFile)).mode & 0o777, 0o600)
  const firstExit = once(first, 'exit')
  first.kill('SIGTERM')
  await firstExit

  const second = start()
  t.after(() => { if (second.exitCode === null && second.signalCode === null) second.kill('SIGTERM') })
  const secondBase = await waitForServer(second)
  const secondUrl = (await readSaved(firstUrl)).trim()
  assert.equal(new URL(secondUrl).origin, secondBase)
  assert.ok(new URL(secondUrl).searchParams.get('token'))
  assert.notEqual(secondUrl, firstUrl)
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
  token = 'cookie-auth',
}) {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const headers = [
    `GET /rpc?token=${encodeURIComponent(token)}&server=local HTTP/1.1`,
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

test('unauthenticated gateway admits only local or explicitly public authorities', async t => {
  const webRoot = await mkdtemp(join(tmpdir(), 'kcoder-gateway-admission-'))
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>isolated</body></html>')
  await writeFile(join(webRoot, 'servers.json'), JSON.stringify([{ id: 'local', label: 'Local', runtime: 'kcoder', transport: 'local' }]))
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: '', KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_WEB_ROOT: webRoot,
    KCODER_STUDIO_SERVERS_FILE: join(webRoot, 'servers.json'),
    KCODER_STUDIO_SERVERS_STORE: '', KCODER_STUDIO_SERVERS: '',
    KCODER_STUDIO_WORKSPACE: webRoot,
    KCODER_STUDIO_PUBLIC_ORIGINS: 'https://studio.example:8443',
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: '',
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(webRoot, { recursive: true, force: true })
  })
  const base = await waitForServer(child)
  const port = Number(new URL(base).port)
  const page = await rawHttp({ port })
  assert.equal(page.status, 200)
  const token = page.body.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1]
  assert.ok(token)
  for (const authority of [`unlisted.example:${port}`, 'unlisted.example:8443']) {
    for (const path of ['/', '/api/servers']) {
      assert.equal((await rawHttp({ port, path, headers: { host: authority } })).status, 421, authority)
    }
    assert.equal(await websocketStatus({ port, authority, origin: `http://${authority}`, token }), null)
  }
  for (const authority of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal((await rawHttp({ port, path: '/api/servers', headers: { host: authority } })).status, 200)
    assert.equal(await websocketStatus({ port, authority, origin: `http://${authority}`, token }), 101)
  }
  assert.equal((await rawHttp({ port, path: '/api/servers', headers: { host: 'studio.example:8443' } })).status, 200)
  assert.equal(await websocketStatus({ port, authority: 'studio.example:8443', origin: 'https://studio.example:8443', token }), 101)
  assert.equal(await websocketStatus({ port, authority: 'studio.example:8443', origin: 'http://studio.example:8443', token }), null)
  assert.equal(await websocketStatus({ port, origin: 'http://unlisted.example', token }), null)
  assert.equal((await rawHttp({ port, headers: { origin: 'http://unlisted.example' } })).status, 403)
  assert.equal((await rawHttp({ port, path: '/api/servers', headers: { origin: `${base}/unexpected-path` } })).status, 403)
})

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
  assert.ok(payload.length <= 0xffff, 'test frame helper payload exceeds the 16-bit frame bound')
  const head = Buffer.alloc(payload.length < 126 ? 2 : 4)
  head[0] = 0x81
  head[1] = 0x80 | (payload.length < 126 ? payload.length : 126)
  if (payload.length >= 126) head.writeUInt16BE(payload.length, 2)
  const mask = Buffer.from([0x31, 0x42, 0x53, 0x64])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([head, mask, masked])
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

test('Gateway settings can issue a weekly mobile pairing QR credential and revoke paired devices', async t => {
  const port = await unusedPort()
  const child = launch({
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'mobile-qr-admin-token',
    KCODER_STUDIO_PUBLIC_ORIGINS: 'https://relay.example',
    KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://relay.example/g/gateway-one',
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
    body: new URLSearchParams({ token: 'mobile-qr-admin-token' }),
  })
  assert.equal(login.status, 303)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const adminHeaders = { cookie }
  const pairingResponse = await fetch(`${base}/api/mobile/pairing`, { headers: adminHeaders })
  assert.equal(pairingResponse.status, 200)
  const pairing = await pairingResponse.json()
  assert.equal(typeof pairing.token, 'string')
  assert.equal(pairing.publicBaseUrl, 'https://relay.example/g/gateway-one')
  assert.notEqual(pairing.token, 'mobile-qr-admin-token')
  assert.equal(pairing.expiresAt % (7 * 24 * 60 * 60_000), 0)
  assert.deepEqual(pairing.devices, [])

  const legacyExchange = await fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: pairing.token }),
  })
  assert.equal(legacyExchange.status, 401, 'pairing credentials cannot create a legacy short-lived session')

  const exchange = async token => fetch(`${base}/api/mobile/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, durableDeviceAuthorization: true, deviceLabel: 'QR test phone' }),
  })
  const mobile = await exchange(pairing.token)
  assert.equal(mobile.status, 200)
  const mobileGrant = await mobile.json()
  const listed = await fetch(`${base}/api/mobile/pairing`, { headers: adminHeaders })
  assert.equal((await listed.json()).devices[0].id, mobileGrant.deviceId)
  assert.equal((await fetch(`${base}/api/mobile/pairing`, {
    headers: { authorization: `Bearer ${mobileGrant.accessToken}` },
  })).status, 403, 'a paired phone cannot read the admin pairing secret')

  const rotatedResponse = await fetch(`${base}/api/mobile/pairing`, {
    method: 'POST',
    headers: { ...adminHeaders, origin: base, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(rotatedResponse.status, 200)
  const rotated = await rotatedResponse.json()
  assert.notEqual(rotated.token, pairing.token)
  assert.equal((await exchange(pairing.token)).status, 401, 'rotation immediately rejects the old QR')
  const nextMobile = await exchange(rotated.token)
  assert.equal(nextMobile.status, 200)

  const removed = await fetch(`${base}/api/mobile/pairing/devices/${encodeURIComponent(mobileGrant.deviceId)}`, {
    method: 'DELETE',
    headers: { ...adminHeaders, origin: base, 'content-type': 'application/json' },
  })
  assert.equal(removed.status, 204)
  const refresh = await fetch(`${base}/api/mobile/session/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: mobileGrant.refreshToken, rotationId: 'review-revoke-check-01' }),
  })
  assert.equal(refresh.status, 401)
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
  const authority = `authenticated.example:${port}`
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
  assert.equal(await websocketStatus({ port, cookie, origin: 'https://studio.example', authority: 'studio.example' }), null,
    'the local HTTP cookie cannot authenticate the public HTTPS host')
  const publicLogin = await new Promise((resolve, reject) => {
    const body = new URLSearchParams({ token: 'test-token' }).toString()
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/login', method: 'POST',
      headers: { host: 'studio.example', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
      response.resume()
      response.on('end', () => resolve(response))
    })
    request.once('error', reject)
    request.end(body)
  })
  assert.equal(publicLogin.statusCode, 303)
  const publicSetCookie = publicLogin.headers['set-cookie'][0]
  assert.match(publicSetCookie, /^__Host-kcoder_studio_session=/)
  assert.match(publicSetCookie, /; Path=\/;/)
  assert.match(publicSetCookie, /; Secure$/)
  assert.equal(await websocketStatus({ port, cookie: publicSetCookie.split(';', 1)[0], origin: 'https://studio.example', authority: 'studio.example' }), 101)
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
  const runtimePackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(payload.gatewayRuntimeVersion, runtimePackage.version)
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

test('server status does not reuse an isolated target account across Gateway owners', async t => {
  const gateway = await startAccountStatusGateway(t)
  const aliceSession = await gateway.createMobileSession()
  const bobSession = await gateway.createMobileSession()
  await gateway.loginAs(aliceSession.accessToken, 'alice')

  const alice = await gateway.readStatus(aliceSession.accessToken)
  assert.equal(alice.statuses[0].appServerVersion, '1.2.3')
  assert.equal(alice.statuses[0].protocolVersion, '2026-07-27')

  const bobBeforeLogin = await gateway.readStatus(bobSession.accessToken)
  assert.equal(bobBeforeLogin.statuses[0].status, 'offline')
  assert.match(bobBeforeLogin.statuses[0].error, /需要登录/)
  assert.equal(bobBeforeLogin.statuses[0].appServerVersion ?? null, null)
  assert.equal(bobBeforeLogin.statuses[0].protocolVersion ?? null, null)

  await gateway.loginAs(bobSession.accessToken, 'bob')
  const bob = await gateway.readStatus(bobSession.accessToken)
  assert.equal(bob.statuses[0].appServerVersion, '9.8.7')
  assert.equal(bob.statuses[0].protocolVersion, '2026-08-31')
  const aliceAgain = await gateway.readStatus(aliceSession.accessToken)
  assert.equal(aliceAgain.statuses[0].appServerVersion, '1.2.3')
  assert.equal(aliceAgain.statuses[0].protocolVersion, '2026-07-27')
  assert.doesNotMatch(JSON.stringify([alice, bobBeforeLogin, bob, aliceAgain]), /test-alice-password|test-bob-password/)
})

test('concurrent status probes keep isolated account health and versions separate', async t => {
  const gateway = await startAccountStatusGateway(t)
  const aliceSession = await gateway.createMobileSession()
  const bobSession = await gateway.createMobileSession()
  await Promise.all([
    gateway.loginAs(aliceSession.accessToken, 'alice'),
    gateway.loginAs(bobSession.accessToken, 'bob'),
  ])

  const [alice, bob] = await Promise.all([
    gateway.readStatus(aliceSession.accessToken),
    gateway.readStatus(bobSession.accessToken),
  ])
  assert.equal(alice.statuses[0].appServerVersion, '1.2.3')
  assert.equal(alice.statuses[0].protocolVersion, '2026-07-27')
  assert.equal(bob.statuses[0].appServerVersion, '9.8.7')
  assert.equal(bob.statuses[0].protocolVersion, '2026-08-31')
  assert.doesNotMatch(JSON.stringify([alice, bob]), /test-alice-password|test-bob-password/)
})

test('an in-flight status probe cannot cache a prior account generation', async t => {
  const gateway = await startAccountStatusGateway(t, { addBarrierTarget: true })
  const session = await gateway.createMobileSession()
  await gateway.loginAs(session.accessToken, 'alice')
  await gateway.loginAs(session.accessToken, 'alice', 'peer')

  // The barrier target's held initialize keeps this status HTTP request open
  // while the isolated account changes generations.
  let probeSettled = false
  const oldAccountProbe = gateway.readStatus(session.accessToken).finally(() => { probeSettled = true })
  await gateway.waitForBarrierProbe()
  await gateway.logout(session.accessToken, 'isolated')
  await gateway.loginAs(session.accessToken, 'bob')
  assert.equal(probeSettled, false, 'The original status response must remain held until the account switch finishes')
  await gateway.releaseBarrierProbe()

  const oldResult = await oldAccountProbe
  const staleIsolatedStatus = oldResult.statuses.find(status => status.id === 'isolated')
  assert.equal(staleIsolatedStatus.status, 'offline')
  assert.equal(staleIsolatedStatus.appServerVersion, null)
  assert.equal(staleIsolatedStatus.protocolVersion, null)
  assert.equal(staleIsolatedStatus.accountIdentity.username, 'bob')
  assert.match(staleIsolatedStatus.error, /账号状态.*已变更/)
  const unchangedPeerStatus = oldResult.statuses.find(status => status.id === 'peer')
  assert.equal(unchangedPeerStatus.status, 'online')
  assert.equal(unchangedPeerStatus.appServerVersion, '1.2.3')
  assert.equal(unchangedPeerStatus.protocolVersion, '2026-07-27')
  assert.equal(unchangedPeerStatus.accountIdentity.username, 'alice')
  const barrierStatus = oldResult.statuses.find(status => status.id === 'barrier')
  assert.equal(barrierStatus.appServerVersion, '3.4.5')
  assert.equal(barrierStatus.protocolVersion, '2026-09-30')

  const currentResult = await gateway.readStatus(session.accessToken)
  const currentIsolatedStatus = currentResult.statuses.find(status => status.id === 'isolated')
  assert.equal(currentIsolatedStatus.status, 'online')
  assert.equal(currentIsolatedStatus.accountIdentity.username, 'bob')
  assert.equal(currentIsolatedStatus.appServerVersion, '9.8.7')
  assert.equal(currentIsolatedStatus.protocolVersion, '2026-08-31')
  assert.doesNotMatch(JSON.stringify(currentIsolatedStatus), /1\.2\.3|2026-07-27|alice/)
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

test('uninitialized RPC connections stay exclusive until resident capability is known', { timeout: 15_000 }, async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-studio-resident-singleflight-'))
  const workspace = join(dataDir, 'workspace')
  const store = join(dataDir, 'servers.json')
  const command = join(dataDir, 'resident-app-server')
  const pidFile = join(dataDir, 'children.log')
  await mkdir(workspace)
  await writeFile(command, String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'resident-test' }, capabilities: { experimental: { residentThreads: true } } } }) + '\n');
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
  const gatewayClosed = new Promise(resolve => child.once('close', resolve))
  const sockets = new Set()
  t.after(async () => {
    await Promise.all([...sockets].map(socket => new Promise(resolve => {
      if (socket.readyState === 'closed') { resolve(); return }
      socket.once('close', resolve)
      socket.destroy()
    })))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await gatewayClosed
    await rm(dataDir, { recursive: true, force: true })
  })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/api/mobile/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-token' }),
  }).then(value => value.json())

  const readChildPids = async () => (await readFile(pidFile, 'utf8')).trim().split(/\s+/).filter(Boolean)
  const openConnection = async () => {
    const socket = await openAuthorizedWebsocket({ port, bearer: login.accessToken, serverId: 'resident' })
    sockets.add(socket)
    return socket
  }
  const initialize = (socket, id) => new Promise((resolve, reject) => {
    let bytes = ''
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', received)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`resident initialize ACK missing for connection ${id}`))
    }, 5000)
    const received = chunk => {
      bytes += chunk.toString('utf8')
      if (bytes.includes(`"id":${id}`) && bytes.includes('resident-test')) {
        cleanup()
        resolve()
      }
    }
    socket.on('data', received)
    socket.write(clientTextFrame({ jsonrpc: '2.0', id, method: 'initialize', params: {
      protocolVersion: '2026-07-27', clientInfo: { name: 'resident-test-client', version: '1' },
    } }))
  })

  const first = await openConnection()
  // The second upgrade must complete while the first client has not initialized.
  const second = await openConnection()
  await Promise.all([initialize(first, 1), initialize(second, 2)])
  // Each fixture writes its PID before sending its initialize acknowledgement.
  const exclusiveChildren = await readChildPids()
  assert.equal(new Set(exclusiveChildren).size, 2,
    `expected two exclusive children before capabilities were known, got ${exclusiveChildren.join(',')}`)

  const third = await openConnection()
  await initialize(third, 3)
  const childrenAfterThird = await readChildPids()
  assert.equal(new Set(childrenAfterThird).size, 2,
    `expected third initialized connection to reuse a resident app-server, got ${childrenAfterThird.join(',')}`)
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


test('full capacity rejects browser and legacy logins while durable pairing evicts the oldest device', { timeout: 45_000 }, async t => {
  const token = 'owned-capacity-fixture-token'
  const child = launch({ KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: token, KCODER_STUDIO_MOCK: '1' })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
    }
  })
  const base = await waitForServer(child)
  const login = () => fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, returnTo: '/sessions' }) })
  const emptyLogin = await login(); await emptyLogin.arrayBuffer()
  assert.equal(emptyLogin.status, 303)
  const cookie = emptyLogin.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const logout = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
  await logout.arrayBuffer(); assert.equal(logout.status, 303)
  const session = durableDeviceAuthorization => fetch(`${base}/api/mobile/session`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, durableDeviceAuthorization }) })
  const grants = []
  for (let i = 0; i < 32; i += 1) {
    const response = await session(true)
    assert.equal(response.status, 200, 'all original durable grants fit')
    grants.push(await response.json())
  }
  assert.equal(new Set(grants.map(grant => grant.deviceId)).size, 32)
  assert.equal(new Set(grants.map(grant => grant.accessToken)).size, 32)
  const fullLogin = await login()
  const html = await fullLogin.text()
  assert.equal(fullLogin.status, 429)
  assert.match(fullLogin.headers.get('content-type') || '', /text\/html/)
  assert.equal(fullLogin.headers.get('set-cookie'), null)
  assert.match(html, /登录会话已满/)
  assert.match(html, /\/sessions/)
  const legacy = await session(false)
  assert.equal(legacy.status, 429)
  assert.equal(legacy.headers.get('set-cookie'), null)
  const legacyBody = await legacy.json()
  assert.equal(typeof legacyBody.error, 'string')
  assert.equal(Object.hasOwn(legacyBody, 'accessToken'), false)
  const overflow = await session(true)
  assert.equal(overflow.status, 200, 'durable pairing evicts the oldest device to stay within capacity')
  const replacement = await overflow.json()
  assert.equal(typeof replacement.accessToken, 'string')
  assert.equal(new Set([...grants.map(grant => grant.deviceId), replacement.deviceId]).size, 33)
  const activeGrants = [...grants.slice(1), replacement]
  const active = await fetch(`${base}/api/mobile/devices`, { headers: { authorization: `Bearer ${grants[1].accessToken}` } })
  assert.equal(active.status, 200)
  const activeDevices = (await active.json()).devices
  assert.equal(activeDevices.length, 32)
  assert.deepEqual(new Set(activeDevices.map(device => device.id)), new Set(activeGrants.map(grant => grant.deviceId)),
    'only the oldest grant is evicted and the replacement occupies its capacity')
  assert.ok(!activeDevices.some(device => device.id === grants[0].deviceId))
  assert.ok(activeGrants.every(grant => activeDevices.some(device => device.id === grant.deviceId)))
  const evicted = await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${grants[0].accessToken}` } })
  assert.equal(evicted.status, 401, 'the oldest access authorization is revoked')
  await evicted.arrayBuffer()
  for (const grant of activeGrants) {
    const accepted = await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${grant.accessToken}` } })
    assert.equal(accepted.status, 200, 'the other 31 grants and replacement remain usable')
    await accepted.arrayBuffer()
  }
  for (const grant of activeGrants) {
    const revoked = await fetch(`${base}/api/mobile/session`, { method: 'DELETE',
      headers: { authorization: `Bearer ${grant.accessToken}` } })
    assert.equal(revoked.status, 204); await revoked.arrayBuffer()
  }
  const recovered = await login(); await recovered.arrayBuffer()
  assert.equal(recovered.status, 303)
})


test('failed login at mixed durable capacity preserves the existing host cookie', { timeout: 45_000 }, async t => {
  const token = 'owned-mixed-capacity-token'
  const child = launch({ KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_AUTH_TOKEN: token, KCODER_STUDIO_MOCK: '1' })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
    }
  })
  const base = await waitForServer(child)
  const login = () => fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) })
  const host = await login(); await host.arrayBuffer(); assert.equal(host.status, 303)
  const cookie = host.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const grants = []
  for (let i = 0; i < 32; i += 1) {
    const response = await fetch(`${base}/api/mobile/session`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token, durableDeviceAuthorization: true }) })
    assert.equal(response.status, 200); grants.push(await response.json())
  }
  assert.equal(new Set(grants.map(grant => grant.deviceId)).size, 32)
  assert.equal(new Set(grants.map(grant => grant.accessToken)).size, 32)
  const before = await fetch(`${base}/api/servers`, { headers: { cookie } })
  assert.equal(before.status, 200); await before.arrayBuffer()
  const refused = await login(); await refused.arrayBuffer()
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('set-cookie'), null)
  for (const grant of grants) {
    const accepted = await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${grant.accessToken}` } })
    assert.equal(accepted.status, 200); await accepted.arrayBuffer()
  }
  const active = await fetch(`${base}/api/mobile/devices`, { headers: { authorization: `Bearer ${grants[0].accessToken}` } })
  assert.equal(active.status, 200); assert.equal((await active.json()).devices.length, 32)
  const preserved = await fetch(`${base}/api/servers`, { redirect: 'manual', headers: { cookie } })
  await preserved.arrayBuffer()
  assert.equal(preserved.status, 200, 'failed capacity admission must not evict the existing host session')
})


test('full Gateway mobile authority preserves supported target configuration management', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kc-mobile-server-admin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = join(directory, 'servers.json')
  const child = launch({ KCODER_STUDIO_PORT: '0', KCODER_STUDIO_AUTH_TOKEN: 'server-admin-token',
    KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_SERVERS_STORE: store,
    KCODER_PRIVATE_RETENTION_VERIFIER_V1: 'ambient-forgery',
    kcoder_private_retention_verifier_v1: 'ambient-lowercase-forgery',
    kcoder_private_retention_parent_v1: 'ambient-parent-forgery' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  const base = await waitForServer(child)
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'server-admin-token' }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const pairing = await fetch(`${base}/api/mobile/pairing`, { headers: { cookie } }).then(value => value.json())
  const mobile = await fetch(`${base}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: pairing.token, durableDeviceAuthorization: true }) }).then(value => value.json())
  assert.equal(typeof mobile.accessToken, 'string')
  const observed = join(directory, 'custom-environment.json')
  const custom = join(directory, 'custom-app-server')
  await writeFile(custom, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ verifier: process.env.KCODER_PRIVATE_RETENTION_VERIFIER_V1 ?? null,
  privateNames: Object.keys(process.env).filter(name => /^kcoder_private_retention_(?:parent|verifier)_v1$/i.test(name)),
  parent: JSON.parse(Buffer.from(process.env.KCODER_PRIVATE_RETENTION_PARENT_V1.slice(3), 'base64url')) }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line);
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: { experimental: { stagedAttachmentRetentionReceiptsV1: true } } } }) + '\n');
});
`, { mode: 0o700 })
  const draft = { id: 'custom-local', label: 'Custom', runtime: 'kcoder', transport: 'local', command: custom, workspace: directory }
  const headers = { authorization: `Bearer ${mobile.accessToken}`, origin: base, 'content-type': 'application/json' }
  assert.equal((await fetch(`${base}/api/servers/custom-local`, { method: 'PUT', headers, body: JSON.stringify(draft) })).status, 200)
  const before = await readFile(store)
  assert.equal(JSON.parse(before).find(row => row.id === draft.id).command, draft.command)
  const probe = await fetch(`${base}/api/servers/test`, { method: 'POST', headers, body: JSON.stringify(draft) })
  assert.equal(probe.status, 200)
  const probed = await probe.json()
  assert.equal(probed.ok, true, JSON.stringify(probed))
  assert.deepEqual(await readFile(store), before, 'testing a target does not alter durable configuration')
  assert.deepEqual(JSON.parse(await readFile(observed)), { verifier: null, privateNames: ['KCODER_PRIVATE_RETENTION_PARENT_V1'], parent: { version: 1, mode: 'localOs' } },
    'custom child retains canonical legacy parent declaration, without ambient fields or verifier material')
  assert.equal((await fetch(`${base}/api/servers`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/api/servers/custom-local`, { method: 'DELETE', headers })).status, 200)
  assert.equal(JSON.parse(await readFile(store)).some(row => row.id === draft.id), false)
})


test('concurrent target mutations retain every accepted update and durable JSON', async t => {
  const port = await unusedPort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kcoder-concurrent-targets-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const store = join(dataDir, 'servers.json')
  const child = launch({ KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: 'test-token', KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_SERVERS_STORE: store })
  t.after(() => { if (!child.killed) child.kill('SIGTERM') })
  await waitForServer(child)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'test-token' }) })
  const headers = { cookie: (login.headers.get('set-cookie') ?? '').split(';', 1)[0], origin: base, 'content-type': 'application/json' }
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
    const id = `parallel-${index}`
    return fetch(`${base}/api/servers/${id}`, { method: 'PUT', headers,
      body: JSON.stringify({ id, label: id, runtime: 'kcoder', transport: 'local', workspace: dataDir, command: '/usr/bin/kcoder' }) })
  }))
  for (const response of results) assert.equal(response.status, 200, await response.text())
  assert.equal(JSON.parse(await readFile(store, 'utf8')).filter(row => row.id.startsWith('parallel-')).length, 8)
  const removed = await Promise.all([0, 1, 2, 3].map(index => fetch(`${base}/api/servers/parallel-${index}`, { method: 'DELETE', headers })))
  for (const response of removed) assert.equal(response.status, 200)
  assert.equal(JSON.parse(await readFile(store, 'utf8')).filter(row => row.id.startsWith('parallel-')).length, 4)
})

import { app, BrowserWindow, ipcMain } from 'electron'
import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeWidgetIsolationController, configureWidgetProcessIsolation } from '../../../desktop/widget-isolation/controller.mjs'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const profile = arg('owned-profile'), reportPath = arg('owned-report')
if (!profile || !path.isAbsolute(profile) || !reportPath || !path.isAbsolute(reportPath)) throw new Error('Absolute owned profile/report required')
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
app.on('window-all-closed', () => {})
configureWidgetProcessIsolation(app)
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label, timeout = 7000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const result = await predicate(); if (result) return result; await wait(50) }
  throw new Error(`${label} timed out`)
}
let window, server, controller, finishing = false
const report = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), actualProductionController: true, actualProductionPreload: true, failure: null }
const watchdog = setTimeout(() => { report.failure = 'External controller probe deadline reached'; void finish(1) }, 20000)
async function finish(code) {
  if (finishing) return
  finishing = true
  clearTimeout(watchdog)
  controller?.dispose()
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  window?.destroy()
  server?.closeAllConnections?.()
  await Promise.race([new Promise(resolve => server ? server.close(resolve) : resolve()), wait(1000)])
  app.exit(code)
}
async function run() {
  try {
    const root = path.dirname(fileURLToPath(import.meta.url))
    const document = await readFile(path.resolve(root, '../../../renderer/public/widget-sandbox/isolated-v1.html'))
    const policy = JSON.parse(await readFile(path.resolve(root, '../../../renderer/public/widget-sandbox/isolated-policy-v1.json')))
    if (createHash('sha256').update(document).digest('hex') !== policy.documentSha256) throw new Error('Sandbox document hash mismatch')
    report.documentSha256 = policy.documentSha256
    await app.whenReady()
    let externalRequests = 0
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/api/widgets/isolated-v1.html') { response.setHeader('Content-Security-Policy', policy.csp); response.end(document) }
      else if (request.url === '/exfil') { externalRequests += 1; response.end('blocked') }
      else response.end('<!doctype html><html><body><p>Studio parent fixture</p><script>globalThis.parentTicks=0;globalThis.revocations=[];globalThis.leases={};globalThis.readyWidgets=[];setInterval(()=>parentTicks++,25);kcoderDesktopHost.widgets.onRevoked(value=>{revocations.push(value);document.getElementsByName(value.widgetId==="widget-a"?"kcoder-widget-11111111-1111-1111-1111-111111111111":"kcoder-widget-22222222-2222-2222-2222-222222222222")[0]?.remove()});addEventListener("message",event=>{const frame=[...document.querySelectorAll("iframe")].find(frame=>frame.contentWindow===event.source);const message=event.data;if(!frame||message?.protocol!=="kcoder-widget"||message.token!=="owned-controller-probe-token-123456")return;const lease=leases[message.widgetId];if(message.type==="ready")readyWidgets.push(message.widgetId);if(message.type==="heartbeat"&&lease)void kcoderDesktopHost.widgets.heartbeat({...lease,...message.payload})})</script></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    window = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, partition: `widget-controller-probe-${process.pid}`, preload: path.resolve(root, '../../../desktop/menu-preload.cjs') } })
    controller = createNativeWidgetIsolationController({ app, ipcMain, getWindow: contents => contents === window.webContents ? window : undefined, getGatewayOrigin: () => origin, verifiedPlatforms: ['win32'] })
    await window.loadURL(origin)
    const capability = await window.webContents.executeJavaScript('kcoderDesktopHost.widgets.getCapabilities()')
    report.capability = capability
    if (!capability.isolatedHtml) {
      report.blockedAsExpected = process.platform !== 'win32' || report.noSandboxSwitch
      if (!report.blockedAsExpected) throw new Error('Verified Windows host did not expose isolated JavaScript capability')
      await finish(0); return
    }
    const names = ['kcoder-widget-11111111-1111-1111-1111-111111111111', 'kcoder-widget-22222222-2222-2222-2222-222222222222']
    await window.webContents.executeJavaScript(`for(const name of ${JSON.stringify(names)}){const frame=document.createElement('iframe');frame.name=name;frame.sandbox='allow-scripts';frame.src=${JSON.stringify(`${origin}/api/widgets/isolated-v1.html`)};document.body.append(frame)}`)
    const frames = await until(() => { const found = names.map(name => window.webContents.mainFrame.frames.find(frame => frame.name === name && frame.url === `${origin}/api/widgets/isolated-v1.html`)); return found.every(Boolean) ? found : null }, 'two owned documents')
    await wait(100)
    report.processIds = { parent: window.webContents.getOSProcessId(), widgets: frames.map(frame => frame.osProcessId) }
    if (new Set([report.processIds.parent, ...report.processIds.widgets]).size !== 3) throw new Error('Per-document widgets reused a protected peer process')
    for (let index = 0; index < 2; index += 1) {
      const id = `widget-${index ? 'b' : 'a'}`
      await window.webContents.executeJavaScript(`kcoderDesktopHost.widgets.authorize(${JSON.stringify({ widgetId: id, revision: 1, frameName: names[index], panelId: 'owned-controller-pane' })}).then(value=>leases[${JSON.stringify(id)}]=value)`)
    }
    report.authorizedCount = controller.activeCount()
    const sources = [
      '<input id="years" type="range" min="1" max="10" value="7"><output id="value"></output><script>const update=()=>document.getElementById("value").textContent=String(560000*1.085**Number(document.getElementById("years").value));document.getElementById("years").oninput=update;update()</script>',
      '<p>Independent peer</p><script>globalThis.peerTicks=0;setInterval(()=>peerTicks++,25)</script>',
    ]
    for (let index = 0; index < 2; index += 1) {
      const message = { protocol: 'kcoder-widget-host', version: 1, type: 'init', token: 'owned-controller-probe-token-123456', widgetId: `widget-${index ? 'b' : 'a'}`, revision: 1, executionMode: 'isolated_html', title: 'Production controller test', source: sources[index], state: {}, theme: { locale: 'en', colorScheme: 'light', foreground: '#202020', background: '#ffffff', muted: '#666666', border: '#dddddd', primary: '#3589df', destructive: '#e84a4a', fontFamily: 'system-ui', fontSize: '14px', reducedMotion: true } }
      await window.webContents.executeJavaScript(`document.getElementsByName(${JSON.stringify(names[index])})[0].contentWindow.postMessage(${JSON.stringify(message)},'*')`)
    }
    await until(() => window.webContents.executeJavaScript('readyWidgets.length===2'), 'first frames')
    report.generatedJsInitialValue = await frames[0].executeJavaScript('Number(document.getElementById("value").textContent)')
    if (Math.abs(report.generatedJsInitialValue - 991279.658373168) > 1e-6) throw new Error('Initial calculation failed')
    await frames[0].executeJavaScript('document.getElementById("years").value="8";document.getElementById("years").dispatchEvent(new Event("input"))')
    report.generatedJsChangedValue = await frames[0].executeJavaScript('Number(document.getElementById("value").textContent)')
    if (Math.abs(report.generatedJsChangedValue - 1075538.4293348873) > 1e-6) throw new Error('Control calculation failed')
    report.childHasNoNativeApi = await frames[0].executeJavaScript('typeof kcoderDesktopHost === "undefined" && typeof require === "undefined" && typeof process === "undefined"')
    report.parentDomBlocked = await frames[0].executeJavaScript('(()=>{try{return parent.document.body.innerHTML,false}catch{return true}})()')
    await frames[1].executeJavaScript(`location.href=${JSON.stringify(`${origin}/exfil`)}`)
    await wait(200)
    report.navigationBlocked = frames[1].url === `${origin}/api/widgets/isolated-v1.html` && externalRequests === 0
    const peerBefore = await frames[1].executeJavaScript('peerTicks')
    const parentBefore = await window.webContents.executeJavaScript('parentTicks')
    void frames[0].executeJavaScript('while(true){}').catch(() => undefined)
    await until(() => window.webContents.executeJavaScript('revocations.some(value=>value.widgetId==="widget-a")'), 'actual native heartbeat revocation')
    report.revocations = await window.webContents.executeJavaScript('revocations')
    report.loopRendererGone = !app.getAppMetrics().some(metric => metric.pid === report.processIds.widgets[0])
    report.peerStillResponsive = await frames[1].executeJavaScript('peerTicks') > peerBefore
    report.parentStillResponsive = await window.webContents.executeJavaScript('parentTicks') > parentBefore
    report.peerRetainedAfterOtherRevocation = controller.activeCount() === 1
    await window.webContents.executeJavaScript('kcoderDesktopHost.widgets.revoke({leaseId:leases["widget-b"].leaseId})')
    report.allOwnedLeasesReleased = controller.activeCount() === 0
    // A probe that hangs before first paint must expire on the external short deadline.
    await window.webContents.executeJavaScript(`readyWidgets=[];revocations=[];{const frame=document.createElement('iframe');frame.name=${JSON.stringify(names[0])};frame.sandbox='allow-scripts';frame.src=${JSON.stringify(`${origin}/api/widgets/isolated-v1.html`)};document.body.append(frame)}`)
    await until(() => window.webContents.mainFrame.frames.some(frame => frame.name === names[0] && frame.url === `${origin}/api/widgets/isolated-v1.html`), 'verification document')
    await wait(100)
    const probeStart = Date.now()
    await window.webContents.executeJavaScript(`kcoderDesktopHost.widgets.authorize(${JSON.stringify({ widgetId: 'widget-a', revision: 2, frameName: names[0], panelId: 'owned-controller-pane', verificationOnly: true })}).then(value=>leases['widget-a']=value)`)
    const probeParentBefore = await window.webContents.executeJavaScript('parentTicks')
    const probeMessage = { protocol: 'kcoder-widget-host', version: 1, type: 'init', token: 'owned-controller-probe-token-123456', widgetId: 'widget-a', revision: 2, executionMode: 'isolated_html', title: 'First-frame probe', source: '<script>while(true){}</script>', state: {}, theme: { locale: 'en', colorScheme: 'light', fontSize: '14px' } }
    await window.webContents.executeJavaScript(`document.getElementsByName(${JSON.stringify(names[0])})[0].contentWindow.postMessage(${JSON.stringify(probeMessage)},'*')`)
    await until(() => window.webContents.executeJavaScript('revocations.some(value=>value.widgetId==="widget-a"&&value.revision===2)'), 'native first-frame verification revocation', 4000)
    report.verificationStartupElapsedMs = Date.now() - probeStart
    report.firstFrameProbeRevokedBeforeReady = await window.webContents.executeJavaScript('readyWidgets.length===0&&revocations.some(value=>value.reason==="component did not become ready")')
    report.firstFrameProbeParentResponsive = await window.webContents.executeJavaScript('parentTicks') > probeParentBefore
    report.firstFrameProbeReleased = controller.activeCount() === 0

    // A full main-document reload must release its authority before waiting for detach.
    await window.webContents.executeJavaScript(`{const frame=document.createElement('iframe');frame.name=${JSON.stringify(names[1])};frame.sandbox='allow-scripts';frame.src=${JSON.stringify(`${origin}/api/widgets/isolated-v1.html`)};document.body.append(frame)}`)
    await until(() => window.webContents.mainFrame.frames.some(frame => frame.name === names[1] && frame.url === `${origin}/api/widgets/isolated-v1.html`), 'navigation-owned document')
    await wait(100)
    await window.webContents.executeJavaScript(`kcoderDesktopHost.widgets.authorize(${JSON.stringify({ widgetId: 'widget-b', revision: 2, frameName: names[1], panelId: 'owned-controller-pane' })}).then(value=>leases['widget-b']=value)`)
    const navigationPid = window.webContents.mainFrame.frames.find(frame => frame.name === names[1]).osProcessId
    await window.loadURL(`${origin}/reloaded`)
    report.ownerNavigationReleased = controller.activeCount() === 0
    await until(() => !app.getAppMetrics().some(metric => metric.pid === navigationPid), 'navigation-owned renderer termination')
    report.ownerNavigationRendererGone = true
    for (const key of ['childHasNoNativeApi', 'parentDomBlocked', 'navigationBlocked', 'loopRendererGone', 'peerStillResponsive', 'parentStillResponsive', 'peerRetainedAfterOtherRevocation', 'allOwnedLeasesReleased', 'firstFrameProbeRevokedBeforeReady', 'firstFrameProbeParentResponsive', 'firstFrameProbeReleased', 'ownerNavigationReleased', 'ownerNavigationRendererGone']) if (!report[key]) throw new Error(`Native controller assertion failed: ${key}`)
    await finish(0)
  } catch (error) { report.failure = String(error.message); await finish(1) }
}
void run()

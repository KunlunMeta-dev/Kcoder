import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { widgetResourceViolation, NATIVE_WIDGET_LIMITS } from '../../../desktop/widget-isolation/policy.mjs'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const profile = arg('owned-profile'), reportPath = arg('owned-report'), bridgePath = arg('owned-bridge')
if (![profile, reportPath, bridgePath].every(value => value && path.isAbsolute(value))) throw new Error('Absolute owned profile/report/bridge required')
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
app.on('window-all-closed', () => {})
app.commandLine.appendSwitch('enable-features', 'IsolateSandboxedIframes:grouping/per-document')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let window, server, finishing = false
const report = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), osSandboxVerified: false, resourceBudget: NATIVE_WIDGET_LIMITS, cases: [], failure: null }
const watchdog = setTimeout(() => { report.failure = 'External owner deadline reached'; void finish(1) }, 30000)
async function finish(code) {
  if (finishing) return
  finishing = true
  clearTimeout(watchdog)
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
    const bridgeSource = await readFile(bridgePath)
    const policy = JSON.parse(await readFile(path.resolve(root, '../../../renderer/public/widget-sandbox/isolated-policy-v1.json')))
    if (createHash('sha256').update(document).digest('hex') !== policy.documentSha256) throw new Error('Sandbox document identity mismatch')
    report.documentSha256 = policy.documentSha256
    await app.whenReady()
    let networkRequests = 0
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/api/widgets/isolated-v1.html') {
        response.setHeader('Content-Security-Policy', policy.csp)
        response.end(document)
      } else if (request.url === '/bridge.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bridgeSource) }
      else if (request.url === '/exfil') { networkRequests += 1; response.end('forbidden') }
      else response.end('<!doctype html><html><body><p>Parent workbench</p><script src="/bridge.js"></script><script>globalThis.parentTicks=0;globalThis.widgetMessages=[];globalThis.ownerToken="owned-resource-probe-token-1234567890";globalThis.cloneViolation=null;globalThis.cloneReceived=0;globalThis.permitClone=WidgetBridgeLibrary.createWidgetRateLimiter();setInterval(()=>parentTicks++,25);addEventListener("message",event=>{if(event.source!==document.querySelector("iframe")?.contentWindow)return;if(event.data?.jsonrpc==="2.0"){cloneReceived++;if(!permitClone())cloneViolation="component exceeded its message budget";else if(!WidgetBridgeLibrary.isBoundedWidgetJson(event.data,24576))cloneViolation="component exceeded its inbound JSON budget";return}if(event.data?.protocol==="kcoder-widget"&&event.data.token===ownerToken){if(event.data.type==="resize"&&Number.isFinite(event.data.payload.height))document.querySelector("iframe").style.height=Math.max(120,Math.ceil(event.data.payload.height))+"px";widgetMessages.push(event.data);if(widgetMessages.length>2000)widgetMessages.shift()}})</script></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    window = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, partition: `widget-resource-probe-${process.pid}` } })
    await window.loadURL(origin)
    const cases = [
      ['interactive', '<input id="years" type="range" min="1" max="10" value="7"><output id="value"></output><details id="long-content"><summary>Full visualization</summary><div style="height:1600px">End of long content</div></details><script>const update=()=>document.getElementById("value").textContent=String(560000*1.085**Number(document.getElementById("years").value));document.getElementById("years").oninput=update;update();fetch("/exfil").catch(()=>{});</script>'],
      ['canvas-resize', '<canvas width="300" height="150"></canvas><script>const c=document.querySelector("canvas");c.getContext("2d").fillRect(0,0,1,1);globalThis.dimensionWritesBlocked=0;for(const change of [()=>c.width=100000,()=>c.height=100000,()=>c.setAttribute("width","100000"),()=>c.setAttributeNS(null,"height","100000"),()=>c.getAttributeNode("width").value="100000",()=>c.getAttributeNode("height").nodeValue="100000",()=>c.getAttributeNode("width").textContent="100000",()=>{const a=document.createAttribute("height");a.value="100000";c.attributes.setNamedItem(a)}]){try{change()}catch(error){if(String(error).includes("widget_quota"))dimensionWritesBlocked++}}</script>'],
      ['dom', '<div id="many"></div><script>for(let i=0;i<5000;i++)document.getElementById("many").append(document.createElement("p"));</script>'],
      ['canvas', '<canvas width="2500" height="2500"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,2500,2500)</script>'],
      ['memory', '<script>window.ownedPressure=new Uint8Array(224*1024*1024);ownedPressure.fill(1)</script>'],
      ['flood', '<script>for(let i=0;i<1000;i++)window.kworker.sendPrompt("owned message flood")</script>'],
      ['clone-transfer', '<script>const ownedPayload=new ArrayBuffer(8*1024*1024);new Uint8Array(ownedPayload).fill(7);parent.postMessage({jsonrpc:"2.0",id:1,method:"tools/call",params:{payload:ownedPayload}},"*",[ownedPayload])</script>'],
      ['clone-flood', '<script>const ownedText="x".repeat(256*1024);for(let i=0;i<64;i++)parent.postMessage({jsonrpc:"2.0",id:i,method:"tools/call",params:{text:ownedText}},"*")</script>'],
      ['loop', '<script>while(true){}</script>'],
    ]
    for (const [name, source] of cases) {
      await window.webContents.executeJavaScript(`widgetMessages=[];cloneViolation=null;cloneReceived=0;permitClone=WidgetBridgeLibrary.createWidgetRateLimiter();document.querySelectorAll('iframe').forEach(frame=>frame.remove());{const frame=document.createElement('iframe');frame.name='kcoder-widget-resource-${name}';frame.sandbox='allow-scripts';frame.src=${JSON.stringify(`${origin}/api/widgets/isolated-v1.html`)};document.body.append(frame)}`)
      let frame
      for (let i = 0; i < 100; i += 1) {
        frame = window.webContents.mainFrame.frames.find(frame => frame.name === `kcoder-widget-resource-${name}` && frame.url === `${origin}/api/widgets/isolated-v1.html`)
        if (frame) break
        await wait(25)
      }
      if (!frame || frame.osProcessId === window.webContents.getOSProcessId()) throw new Error('Resource probe frame is not process-separated')
      await wait(50)
      let peer, peerBefore
      if (name.startsWith('clone-')) {
        await window.webContents.executeJavaScript(`{const frame=document.createElement('iframe');frame.name='kcoder-widget-resource-peer';frame.sandbox='allow-scripts';frame.src=${JSON.stringify(`${origin}/api/widgets/isolated-v1.html`)};document.body.append(frame)}`)
        for (let i = 0; i < 100; i += 1) { peer = window.webContents.mainFrame.frames.find(frame => frame.name === 'kcoder-widget-resource-peer' && frame.url === `${origin}/api/widgets/isolated-v1.html`); if (peer) break; await wait(25) }
        if (!peer || new Set([frame.osProcessId, peer.osProcessId, window.webContents.getOSProcessId()]).size !== 3) throw new Error('Message pressure peer is not separately owned')
        await wait(50)
        await window.webContents.executeJavaScript(`document.getElementsByName('kcoder-widget-resource-peer')[0].contentWindow.postMessage(${JSON.stringify({ protocol: 'kcoder-widget-host', version: 1, type: 'init', token: 'owned-resource-probe-token-1234567890', widgetId: 'pressure-peer', revision: 1, executionMode: 'isolated_html', title: 'Independent peer', source: '<script>globalThis.peerTicks=0;setInterval(()=>peerTicks++,25)</script>', state: {}, theme: {} })},'*')`)
        await wait(100)
        peerBefore = await peer.executeJavaScript('peerTicks')
      }
      const identity = { pid: frame.osProcessId, processId: frame.processId }
      const entry = { createdAt: Date.now(), lastHeartbeat: null, ready: false, domNodes: 0, canvasPixels: 0 }
      await window.webContents.executeJavaScript(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocol: 'kcoder-widget-host', version: 1, type: 'init', token: 'owned-resource-probe-token-1234567890', widgetId: name, revision: 1, executionMode: 'isolated_html', title: name, source, state: {}, theme: { locale: 'en', colorScheme: 'light', foreground: '#202020', background: '#ffffff', muted: '#666666', border: '#dddddd', primary: '#3589df', destructive: '#e84a4a', fontFamily: 'system-ui', fontSize: '14px', reducedMotion: true } })},'*')`)
      let violation, peakResidentKiB = 0, messageCount = 0
      for (let i = 0; i < 70; i += 1) {
        await wait(100)
        const messages = await window.webContents.executeJavaScript('widgetMessages.splice(0)')
        messageCount += messages.length
        const heartbeat = messages.filter(message => message.type === 'heartbeat').at(-1)
        if (heartbeat) { entry.lastHeartbeat = Date.now(); entry.ready = heartbeat.payload.ready; entry.domNodes = heartbeat.payload.domNodes; entry.canvasPixels = heartbeat.payload.canvasPixels }
        const metrics = app.getAppMetrics().find(metric => metric.pid === identity.pid)
        peakResidentKiB = Math.max(peakResidentKiB, metrics?.memory.workingSetSize || 0)
        const cloneViolation = name.startsWith('clone-') ? await window.webContents.executeJavaScript('cloneViolation') : null
        violation = cloneViolation || (messageCount > 40 && name === 'flood' ? 'component exceeded its message budget' : widgetResourceViolation(entry, Date.now(), metrics))
        if ((name === 'interactive' || name === 'canvas-resize') && entry.ready) break
        if (violation) break
      }
      const observation = { name, distinctProcess: true, ready: entry.ready, violation: violation || null, domNodes: entry.domNodes, canvasPixels: entry.canvasPixels, peakResidentKiB, messageCount, parentResponsive: false, ownerTerminated: false }
      const before = await window.webContents.executeJavaScript('parentTicks')
      await wait(100)
      observation.parentResponsive = await window.webContents.executeJavaScript('parentTicks') > before
      if (name === 'canvas-resize') {
        observation.dimensionWritesBlocked = await frame.executeJavaScript('dimensionWritesBlocked')
        if (observation.dimensionWritesBlocked !== 8) throw new Error('Canvas backing-store resize guard did not reject every observed native write')
        if (!await frame.executeJavaScript('document.querySelector("canvas").width===300&&document.querySelector("canvas").height===150')) throw new Error('Rejected canvas writes changed the native dimensions')
      } else if (name === 'interactive') {
        if (Math.abs(await frame.executeJavaScript('Number(document.getElementById("value").textContent)') - 991279.658373168) > 1e-6) throw new Error('Raw JavaScript calculation mismatch')
        await frame.executeJavaScript('document.getElementById("years").value="8";document.getElementById("years").dispatchEvent(new Event("input"))')
        if (Math.abs(await frame.executeJavaScript('Number(document.getElementById("value").textContent)') - 1075538.4293348873) > 1e-6) throw new Error('Raw JavaScript control failed')
        observation.networkBlocked = networkRequests === 0
        await frame.executeJavaScript('document.getElementById("long-content").open=true')
        await wait(400)
        const expandedHeight = await window.webContents.executeJavaScript('document.querySelector("iframe").clientHeight')
        const layout = await frame.executeJavaScript('({ maxHeight:getComputedStyle(document.getElementById("widget-root")).maxHeight,overflowY:getComputedStyle(document.getElementById("widget-root")).overflowY,documentHeight:document.scrollingElement.scrollHeight,viewport:innerHeight })')
        if (expandedHeight <= 1600 || layout.maxHeight !== 'none' || layout.overflowY !== 'visible' || layout.documentHeight > layout.viewport + 1) throw new Error('Isolated visualization retained an internal height or scroll limit')
        await frame.executeJavaScript('document.getElementById("long-content").open=false')
        await wait(400)
        const collapsedHeight = await window.webContents.executeJavaScript('document.querySelector("iframe").clientHeight')
        if (collapsedHeight >= expandedHeight) throw new Error('Isolated visualization did not shrink with its content')
        observation.contentSizing = { expandedHeight, collapsedHeight, internalVerticalScroll:false }

      } else {
        if (!violation) throw new Error(`No actual resource violation detected for ${name}`)
        if (frame.isDestroyed() || frame.osProcessId !== identity.pid || frame.processId !== identity.processId || identity.pid === window.webContents.getOSProcessId()) throw new Error('Owned renderer identity changed before termination')
        process.kill(identity.pid, 'SIGKILL')
        await wait(100)
        observation.ownerTerminated = !app.getAppMetrics().some(metric => metric.pid === identity.pid)
        if (!observation.ownerTerminated) throw new Error(`Owned renderer still present after ${name} termination`)
      }
      if (peer) {
        observation.nativePeerSeparated = true
        observation.peerStillResponsive = await peer.executeJavaScript('peerTicks') > peerBefore
        observation.peerRetainedAfterRevocation = !peer.isDestroyed() && app.getAppMetrics().some(metric => metric.pid === peer.osProcessId)
        observation.actualMessageCount = await window.webContents.executeJavaScript('cloneReceived')
        observation.payloadBudgetBytes = name === 'clone-transfer' ? 8 * 1024 * 1024 : 64 * 256 * 1024
        await window.webContents.executeJavaScript('document.querySelector("iframe").remove()')
        observation.componentFrameClosed = await window.webContents.executeJavaScript('document.querySelectorAll("iframe").length===1')
        const ticks = await window.webContents.executeJavaScript('parentTicks')
        await wait(100)
        observation.parentResponsiveAfterClose = await window.webContents.executeJavaScript('parentTicks') > ticks
      }
      report.cases.push(observation)
    }
    report.networkRequests = networkRequests
    await finish(0)
  } catch (error) { report.failure = String(error.message); await finish(1) }
}
void run()

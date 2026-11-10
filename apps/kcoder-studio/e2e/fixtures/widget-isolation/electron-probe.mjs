import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const profile = argument('owned-profile')
const reportPath = argument('owned-report')
if (!profile || !path.isAbsolute(profile) || !reportPath || !path.isAbsolute(reportPath)) throw new Error('An absolute task-owned profile and report are required')
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
// The task owner writes its authoritative receipt before explicitly exiting on every OS.
app.on('window-all-closed', () => {})
const feature = argument('isolation-feature') || 'default'
if (feature === 'disabled') app.commandLine.appendSwitch('disable-features', 'IsolateSandboxedIframes')
else if (feature === 'per-document') app.commandLine.appendSwitch('enable-features', 'IsolateSandboxedIframes:grouping/per-document')
else if (feature !== 'default') throw new Error('Invalid isolation feature enum')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const bounded = (promise, milliseconds, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) })]).finally(() => clearTimeout(timer))
}
const flags = new Map()
ipcMain.on('kcoder-widget-isolation-probe', (event, value) => {
  if (event.senderFrame === event.sender.mainFrame) flags.set(event.sender.id, value)
})
let server
let window
let guest
let guestContents
const report = { feature, electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), osSandboxVerified: false, iframe: {}, independentWebContents: {}, failure: null }
const timeout = setTimeout(() => { report.failure = 'Owner watchdog exceeded 20 seconds'; void finish(1) }, 20000)
let finishing = false
async function finish(code) {
  if (finishing) return
  finishing = true
  clearTimeout(timeout)
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  try { if (guestContents && !guestContents.isDestroyed()) guestContents.close({ waitForBeforeUnload: false }) } catch { /* Only this owned guest may be terminated. */ }
  try { window?.destroy() } catch { /* The task owner still closes its app process. */ }
  const serverClosed = new Promise(resolve => server ? server.close(resolve) : resolve())
  server?.closeAllConnections?.()
  await bounded(serverClosed, 1000, 'Owned listener cleanup').catch(() => undefined)
  console.log(JSON.stringify(report))
  app.exit(code)
}

async function run() {
try {
  report.phase = 'waiting-app-ready'
  await app.whenReady()
  report.phase = 'starting-listener'
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/frame') {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
      response.end('<!doctype html><html><body><input id="years" type="range" min="1" max="10" value="7"><output id="total"></output><script>const update=()=>document.getElementById("total").textContent=String(560000*(1.085**Number(document.getElementById("years").value)));document.getElementById("years").addEventListener("input",update);update();globalThis.frameTicks=0;setInterval(()=>frameTicks++,25);addEventListener("message",event=>{if(event.data==="loop")while(true){}})</script></body></html>')
    } else response.end('<!doctype html><html><body><p>Parent workbench</p><button id="close" onclick="document.querySelector(\'iframe\').remove()">Close</button><iframe name="owned-widget-probe" sandbox="allow-scripts" src="/frame"></iframe><script>globalThis.parentTicks=0;setInterval(()=>parentTicks++,25)</script></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) }
  report.phase = 'creating-window'
  window = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { ...preferences, partition: `widget-probe-parent-${process.pid}` } })
  report.phase = 'loading-parent'
  await window.loadURL(origin)
  report.phase = 'reading-parent-flags'
  await wait(100)
  report.parent = { processId: window.webContents.mainFrame.processId, osProcessId: window.webContents.getOSProcessId(), preload: flags.get(window.webContents.id), preferences: window.webContents.getLastWebPreferences() }
  report.osSandboxVerified = report.parent.preload?.sandboxed === true && !report.noSandboxSwitch
  const frame = window.webContents.mainFrame.frames.find(frame => frame.name === 'owned-widget-probe')
  if (!frame) throw new Error('Owned iframe was not created')
  report.iframe = { processId: frame.processId, osProcessId: frame.osProcessId, distinctFromParent: frame.processId !== window.webContents.mainFrame.processId, interaction: false, parentResponsive: false, closeResponsive: false }
  const calculated = await frame.executeJavaScript('Number(document.getElementById("total").textContent)')
  if (Math.abs(calculated - 991279.658373168) > 1e-6) throw new Error('Actual generated-JS calculation mismatch')
  await frame.executeJavaScript('document.getElementById("years").value="8";document.getElementById("years").dispatchEvent(new Event("input"))')
  if (Math.abs(await frame.executeJavaScript('Number(document.getElementById("total").textContent)') - 1075538.4293348873) > 1e-6) throw new Error('Actual generated-JS input interaction failed')
  report.iframe.interaction = true
  await window.webContents.executeJavaScript('document.querySelector("iframe").contentWindow.postMessage("loop","*")')
  await wait(200)
  try {
    const before = await bounded(window.webContents.executeJavaScript('parentTicks'), 1000, 'Parent heartbeats')
    await wait(150)
    const after = await bounded(window.webContents.executeJavaScript('parentTicks'), 1000, 'Parent advancement')
    report.iframe.parentResponsive = after > before
    await bounded(window.webContents.executeJavaScript('document.getElementById("close").click()'), 1000, 'Parent close')
    report.iframe.closeResponsive = await window.webContents.executeJavaScript('!document.querySelector("iframe")')
  } catch (error) { report.iframe.failure = error.message }
  if (!report.iframe.parentResponsive) { await finish(0) } else {
    guest = new WebContentsView({ webPreferences: { ...preferences, partition: `widget-probe-guest-${process.pid}` } })
    guestContents = guest.webContents
    window.contentView.addChildView(guest)
    guest.setBounds({ x: 40, y: 100, width: 700, height: 400 })
    await guest.webContents.loadURL(`${origin}/frame`)
    await wait(100)
    report.independentWebContents = { processId: guest.webContents.mainFrame.processId, osProcessId: guest.webContents.getOSProcessId(), distinctFromParent: guest.webContents.getOSProcessId() !== window.webContents.getOSProcessId(), preload: flags.get(guest.webContents.id), parentResponsive: false, closeResponsive: false }
    if (!report.independentWebContents.distinctFromParent) throw new Error('Independent guest reused the parent renderer process')
    const loop = guest.webContents.executeJavaScript('while(true){}').catch(() => undefined)
    await wait(200)
    const before = await bounded(window.webContents.executeJavaScript('parentTicks'), 1000, 'Guest-loop parent heartbeat')
    await wait(150)
    report.independentWebContents.parentResponsive = await bounded(window.webContents.executeJavaScript('parentTicks'), 1000, 'Guest-loop parent advancement') > before
    const gone = new Promise(resolve => guest.webContents.once('render-process-gone', resolve))
    // close() alone waits behind a busy renderer; the owner terminates only the verified guest process.
    guest.webContents.forcefullyCrashRenderer()
    await bounded(gone, 2000, 'Owned guest renderer termination')
    const destroyed = new Promise(resolve => guest.webContents.once('destroyed', resolve))
    guest.webContents.close({ waitForBeforeUnload: false })
    await bounded(destroyed, 2000, 'Owned guest contents disposal')
    report.independentWebContents.closeResponsive = guestContents.isDestroyed()
    report.independentWebContents.executionReceiptSettled = await Promise.race([loop.then(() => true), wait(1000).then(() => false)])
    await finish(0)
  }
} catch (error) {
  report.failure = String(error.message)
  await finish(1)
}
}
void run()

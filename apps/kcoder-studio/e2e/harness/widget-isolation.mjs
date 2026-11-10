import http from 'node:http'
import { startChromium } from './chromium.mjs'

const bounded = (promise, milliseconds, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) })]).finally(() => clearTimeout(timer))
}

/** Every browser, listener and hostile frame belongs to this bounded probe. */
export async function probeChromiumWidgetIsolation(context, { executablePath, features = 'default', crossSite = false } = {}) {
  const handleRequest = (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/frame') {
      response.end('<!doctype html><html><body>isolated probe<script>globalThis.frameTicks=0;setInterval(()=>frameTicks++,25);addEventListener("message",e=>{if(e.source===parent&&e.data==="loop"){parent.postMessage("loop-started","*");while(true){}}});parent.postMessage("frame-ready","*")</script></body></html>')
    } else {
      const host = crossSite ? '127.0.0.2' : '127.0.0.1'
      const origin = `http://${host}:${server.address().port}`
      response.end(`<!doctype html><html><body><button id="close">Close owned widget</button><iframe sandbox="allow-scripts" src="${origin}/frame"></iframe><script>globalThis.parentTicks=0;globalThis.loopStarted=false;setInterval(()=>parentTicks++,25);addEventListener('message',event=>{if(event.source===document.querySelector('iframe')?.contentWindow&&event.data==='loop-started')loopStarted=true});document.getElementById('close').onclick=()=>document.querySelector('iframe').remove()</script></body></html>`)
    }
  }
  const server = http.createServer(handleRequest)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const peers = [server]
  if (crossSite) {
    const peer = http.createServer(handleRequest)
    await new Promise(resolve => peer.listen(server.address().port, '127.0.0.2', resolve))
    peers.push(peer)
  }
  const closeServers = () => Promise.all(peers.map(peer => new Promise(resolve => peer.close(resolve))))
  context.registerPort(`widget-probe-${features}-${crossSite}`, server.address().port)
  context.addCleanup(`widget probe HTTP ${features}/${crossSite}`, closeServers)
  const label = `widget-probe-${features}-${crossSite}`
  let chromium
  let browser
  const result = { features, crossSite, parentResponsive: false, closeResponsive: false, frameDetached: false, oopifTargets: 0, failure: null }
  try {
    chromium = await startChromium(context, { executablePath, label, portLabel: `${label}-cdp`, sandboxedIframeIsolation: features === 'disabled' ? 'disabled-for-test' : features === 'per-document' ? 'per-document' : 'browser-default' })
    browser = chromium.browser
    result.browser = await browser.version()
    result.ownedPid = chromium.child.pid
    result.osSandboxEnabled = !chromium.noSandbox
    const page = await chromium.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { timeout: 5000 })
    const frame = page.frames().find(frame => frame.url().endsWith('/frame'))
    await frame.waitForFunction(() => globalThis.frameTicks >= 1, { timeout: 5000 })
    const cdp = await browser.newBrowserCDPSession()
    const targets = await cdp.send('Target.getTargets')
    result.oopifTargets = targets.targetInfos.filter(target => target.type === 'iframe').length
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage('loop', '*'))
    // A busy child can defer its outgoing postMessage; that receipt is not a parent liveness test.
    await new Promise(resolve => setTimeout(resolve, 200))
    const before = await bounded(page.evaluate(() => globalThis.parentTicks), 1500, 'Parent heartbeat read')
    await new Promise(resolve => setTimeout(resolve, 200))
    const after = await bounded(page.evaluate(() => globalThis.parentTicks), 1500, 'Parent heartbeat advancement')
    result.parentResponsive = after > before
    await bounded(page.locator('#close').click({ timeout: 1500 }), 2000, 'Parent close action')
    result.closeResponsive = await bounded(page.evaluate(() => !document.querySelector('iframe')), 1500, 'Closed frame assertion')
    result.frameDetached = frame.isDetached()
  } catch (error) {
    result.failure = String(error.message)
  } finally {
    try { await bounded(chromium?.close() ?? Promise.resolve(), 2000, 'Owned browser close') } catch { await context.stopOwned(label) }
    await closeServers()
  }
  return result
}

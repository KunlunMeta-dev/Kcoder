import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appRoot, runE2E, waitFor, requireExecutable } from '../../harness/run-context.mjs'
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs'

await runE2E(import.meta.url, {
  testId: 'electron-widget-resource-ownership', tier: 'full-integration',
  modelPolicy: 'model-independent actual self-contained generated JavaScript, DOM/canvas/RSS/flood/CPU pressure and native external owner termination; no model calls',
  retainSuccessEvidence: true, evidenceReason: 'Resource budgets require actual native-process enforcement evidence',
}, async context => {
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN || path.join(appRoot, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), 'Electron')
  const display = process.platform === 'linux' ? await startOwnedDisplay(context) : null
  const { build } = createRequire(path.join(appRoot, 'renderer/package.json'))('vite')
  const bridgeBuild = await build({ configFile: false, root: path.join(appRoot, 'renderer'), logLevel: 'error', build: { write: false, minify: false, lib: { entry: path.join(appRoot, 'renderer/src/features/widgets/bridge.ts'), name: 'WidgetBridgeLibrary', formats: ['iife'] } } })
  const bridgeSource = (Array.isArray(bridgeBuild) ? bridgeBuild[0] : bridgeBuild).output.find(item => item.type === 'chunk').code
  const bridgeFile = context.pathInState('widget-bridge.iife.js')
  await writeFile(bridgeFile, bridgeSource)
  const reportFile = context.pathInArtifacts('electron-resources.json')
  const child = context.spawnOwned('electron-widget-resources', electron, [
    ...(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), '--disable-gpu',
    path.join(appRoot, 'e2e/fixtures/widget-isolation/electron-resource-probe.mjs'),
    `--owned-profile=${context.pathInState('electron-profile')}`, `--owned-report=${reportFile}`, `--owned-bridge=${bridgeFile}`,
  ], { env: context.isolatedEnvironment(display ? { DISPLAY: display.display, XAUTHORITY: display.authority } : {}) })
  await waitFor(() => child.exitCode !== null, 40000, 'owned native resource probe', 50, context.abortSignal)
  assert.equal(child.exitCode, 0)
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.equal(report.failure, null)
  assert.equal(report.cases.length, 9)
  assert.equal(report.networkRequests, 0)
  for (const entry of report.cases) {
    assert.equal(entry.distinctProcess, true)
    assert.equal(entry.parentResponsive, true)
    if (entry.name === 'interactive') { assert.ok(entry.contentSizing.expandedHeight > 1600); assert.ok(entry.contentSizing.collapsedHeight < entry.contentSizing.expandedHeight); assert.equal(entry.contentSizing.internalVerticalScroll, false) }
    if (entry.name === 'canvas-resize') assert.equal(entry.dimensionWritesBlocked, 8)
    else if (entry.name !== 'interactive') { assert.equal(entry.ownerTerminated, true); assert.ok(entry.violation) }
    if (entry.name.startsWith('clone-')) {
      for (const key of ['nativePeerSeparated', 'peerStillResponsive', 'peerRetainedAfterRevocation', 'componentFrameClosed', 'parentResponsiveAfterClose']) assert.equal(entry[key], true, `${entry.name}:${key}`)
    }
  }
  return { resourceCases: report.cases.length, osSandboxVerified: report.osSandboxVerified }
})

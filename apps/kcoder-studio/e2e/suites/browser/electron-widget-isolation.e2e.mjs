import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { appRoot, runE2E, waitFor, requireExecutable } from '../../harness/run-context.mjs'
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs'

await runE2E(import.meta.url, {
  testId: 'electron-widget-isolation-native', tier: 'full-integration',
  modelPolicy: 'model-independent actual Electron process IDs, trusted-preload sandbox flags, self-contained JavaScript control and owner-controlled infinite-loop close',
  retainSuccessEvidence: true, evidenceReason: 'Native process identity is required before enabling generated JavaScript',
}, async context => {
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN || path.join(appRoot, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), 'Electron')
  const display = process.platform === 'linux' ? await startOwnedDisplay(context) : null
  const results = []
  for (const feature of ['default', 'disabled', 'per-document']) {
    const reportFile = context.pathInArtifacts(`electron-${feature}.json`)
    const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1'
    const child = context.spawnOwned(`electron-${feature}`, electron, [
      ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), '--disable-gpu',
      path.join(appRoot, 'e2e/fixtures/widget-isolation/electron-probe.mjs'),
      `--owned-profile=${context.pathInState(`electron-${feature}-profile`)}`, `--owned-report=${reportFile}`, `--isolation-feature=${feature}`,
    ], { env: context.isolatedEnvironment(display ? { DISPLAY: display.display, XAUTHORITY: display.authority } : {}) })
    await waitFor(() => child.exitCode !== null, 30000, `owned native Electron ${feature} probe`, 50, context.abortSignal)
    assert.equal(child.exitCode, 0)
    const report = JSON.parse(await readFile(reportFile, 'utf8'))
    results.push(report)
    assert.equal(report.failure, null)
    if (!noSandbox) assert.equal(report.osSandboxVerified, true)
    if (feature === 'disabled') {
      assert.equal(report.iframe.distinctFromParent, false)
      assert.equal(report.iframe.parentResponsive, false)
    } else {
      assert.equal(report.iframe.distinctFromParent, true)
      assert.equal(report.iframe.interaction, true)
      assert.equal(report.iframe.parentResponsive, true)
      assert.equal(report.iframe.closeResponsive, true)
      assert.equal(report.independentWebContents.distinctFromParent, true)
      assert.equal(report.independentWebContents.parentResponsive, true)
      assert.equal(report.independentWebContents.closeResponsive, true)
    }
  }
  await context.writeArtifactJson('electron-isolation-results.json', { results, osSandboxVerified: results.every(result => result.osSandboxVerified), modelCalls: 0 })
  return { nativeCpuIsolation: true, osSandboxVerified: results.every(result => result.osSandboxVerified) }
})

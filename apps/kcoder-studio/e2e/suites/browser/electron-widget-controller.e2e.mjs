import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { appRoot, runE2E, waitFor, requireExecutable } from '../../harness/run-context.mjs'

// Explicit Windows CI selection; the generic Linux matrix cannot prove this OS boundary.
await runE2E(import.meta.url, {
  testId: 'electron-widget-production-controller', tier: 'manual-live',
  modelPolicy: 'model-independent actual Windows production controller/preload IPC, OS sandbox, distinct parent/peer processes and owner watchdog; no model calls or personal configuration',
  retainSuccessEvidence: true, evidenceReason: 'The enabled native JavaScript platform requires production IPC and ownership evidence',
}, async context => {
  if (process.platform !== 'win32') throw new Error('UNMET_PREREQUISITE: production isolated HTML is verified only on Windows')
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1') throw new Error('UNMET_PREREQUISITE: production native widget verification requires the actual OS sandbox')
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN || path.join(appRoot, 'node_modules/electron/dist/electron.exe'), 'verified Electron')
  const inputs = []
  for (const file of ['desktop/widget-isolation/controller.mjs', 'desktop/widget-isolation/policy.mjs', 'desktop/menu-preload.cjs', 'renderer/public/widget-sandbox/isolated-v1.html', 'renderer/public/widget-sandbox/isolated-policy-v1.json', 'e2e/fixtures/widget-isolation/electron-controller-probe.mjs']) {
    const content = await readFile(path.join(appRoot, file))
    inputs.push({ file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  await context.writeArtifactJson('native-controller-inputs.json', inputs)
  const reportFile = context.pathInArtifacts('controller-report.json')
  const child = context.spawnOwned('electron-widget-controller', electron, [path.join(appRoot, 'e2e/fixtures/widget-isolation/electron-controller-probe.mjs'), `--owned-profile=${context.pathInState('electron-profile')}`, `--owned-report=${reportFile}`], { env: context.isolatedEnvironment() })
  await waitFor(() => child.exitCode !== null, 30000, 'owned production widget controller', 50, context.abortSignal)
  assert.equal(child.exitCode, 0)
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.equal(report.failure, null)
  assert.equal(report.noSandboxSwitch, false)
  assert.equal(report.electron, '42.3.3')
  assert.match(report.chromium, /^148\./)
  assert.equal(report.capability.isolatedHtml, true)
  assert.equal(report.authorizedCount, 2)
  assert.equal(new Set([report.processIds.parent, ...report.processIds.widgets]).size, 3)
  for (const key of ['childHasNoNativeApi', 'parentDomBlocked', 'navigationBlocked', 'loopRendererGone', 'peerStillResponsive', 'parentStillResponsive', 'peerRetainedAfterOtherRevocation', 'allOwnedLeasesReleased', 'firstFrameProbeRevokedBeforeReady', 'firstFrameProbeParentResponsive', 'firstFrameProbeReleased', 'ownerNavigationReleased', 'ownerNavigationRendererGone']) assert.equal(report[key], true, key)
  assert.ok(report.verificationStartupElapsedMs >= 2500 && report.verificationStartupElapsedMs < 4000, 'external first-frame verification watchdog')
  return { productionIpcVerified: true, actualOsSandbox: true, modelCalls: 0 }
})

import assert from 'node:assert/strict'
import { runE2E } from '../../harness/run-context.mjs'
import { probeChromiumWidgetIsolation } from '../../harness/widget-isolation.mjs'

await runE2E(import.meta.url, {
  testId: 'widget-isolation-boundaries',
  tier: 'full-integration',
  modelPolicy: 'model-independent actual Chromium OOPIF CPU-loop recovery with a negative feature-disabled control; no generated content or model calls',
  retainSuccessEvidence: true,
  evidenceReason: 'Arbitrary JavaScript enablement requires actual owner-controlled recovery evidence',
}, async context => {
  const results = []
  for (const scenario of [{ features: 'default' }, { features: 'disabled' }, { features: 'per-document' }, { features: 'default', crossSite: true }]) {
    results.push(await probeChromiumWidgetIsolation(context, { executablePath: process.env.KCODER_STUDIO_E2E_BROWSER_EXECUTABLE, ...scenario }))
  }
  await context.writeArtifactJson('isolation-probe.json', {
    results,
    limits: 'CPU loop recovery only. This does not prove bounded memory, full browser compatibility, OS sandboxing when noSandbox is explicitly selected, or actual Electron behavior.',
  })
  for (const result of results.filter(result => result.features !== 'disabled')) {
    assert.equal(result.parentResponsive, true, JSON.stringify(result))
    assert.equal(result.closeResponsive, true, JSON.stringify(result))
    assert.equal(result.frameDetached, true, JSON.stringify(result))
    assert.ok(result.oopifTargets > 0, JSON.stringify(result))
  }
  const negative = results.find(result => result.features === 'disabled')
  assert.equal(negative.parentResponsive, false)
  assert.equal(negative.oopifTargets, 0)
  assert.match(negative.failure, /Parent heartbeat/)
})

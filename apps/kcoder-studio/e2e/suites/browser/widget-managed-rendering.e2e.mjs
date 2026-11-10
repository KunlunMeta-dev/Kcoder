import { runE2E } from '../../harness/run-context.mjs'
import { verifyWidgetSandbox } from '../../harness/widgets-rendering.mjs'

await runE2E(import.meta.url, {
  testId: 'widget-managed-rendering', tier: 'full-integration',
  modelPolicy: 'model-independent real iframe, fixed chart/map libraries, numeric/control/bridge/security acceptance; no model calls',
  retainSuccessEvidence: true, evidenceReason: 'Six visualization forms and source integrity need real browser evidence',
}, async context => {
  const report = await verifyWidgetSandbox(context, { executablePath: process.env.KCODER_STUDIO_E2E_BROWSER_EXECUTABLE })
  await context.writeArtifactJson('widget-rendering-result.json', report)
  return report
})

import { runE2E } from '../../harness/run-context.mjs'
import { verifyContextUsage } from '../browser/context-usage-flow.mjs'

await runE2E(import.meta.url, {
  testId: 'live-context-usage-provider-to-composer',
  tier: 'credentialed-integration',
  modelPolicy: 'real-model-required; one real provider turn; no tools; 1024 output tokens; no retries; 120s limit',
}, context => verifyContextUsage(context, { realModel: true }))

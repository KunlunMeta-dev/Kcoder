import { runE2E } from '../../harness/run-context.mjs'
import { verifyContextUsage } from './context-usage-flow.mjs'

await runE2E(import.meta.url, {
  testId: 'context-usage-provider-to-composer',
  tier: 'full-integration',
  modelPolicy: 'deterministic loopback SSE provider through Vite Renderer, Gateway and KCoder app-server',
}, context => verifyContextUsage(context, { realModel: false }))

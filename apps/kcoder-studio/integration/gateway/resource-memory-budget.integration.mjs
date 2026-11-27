import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

await runIntegration(import.meta.url, { testId: 'gateway-memory-only-idle-budget', tier: 'full-integration',
  modelPolicy: 'model-independent real RSS budget and history-recovery check' },
context => verifyResourceBudget(context, { memoryOnly: true }));

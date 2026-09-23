import { runE2E } from '../../harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

await runE2E(import.meta.url, { testId: 'gateway-memory-only-idle-budget', tier: 'full-integration',
  modelPolicy: 'model-independent real RSS budget and history-recovery check' },
context => verifyResourceBudget(context, { memoryOnly: true }));

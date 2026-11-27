import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

await runIntegration(import.meta.url, { testId: 'gateway-per-target-idle-budget', tier: 'full-integration',
  modelPolicy: 'model-independent deterministic process-budget and history-recovery check' },
context => verifyResourceBudget(context));

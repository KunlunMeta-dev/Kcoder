import { runE2E } from '../../harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

await runE2E(import.meta.url, { testId: 'gateway-bounded-workspace-churn', tier: 'full-integration',
  modelPolicy: 'model-independent bounded eight-workspace eight-round process churn and history recovery; no long-duration leak claim' },
context => verifyResourceBudget(context, { churn: true }));

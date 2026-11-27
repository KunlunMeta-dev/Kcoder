import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

// Remote process lifetime and persisted history are model-independent contracts.
await runIntegration(import.meta.url, { testId: 'gateway-ssh-idle-budget', tier: 'full-integration',
  modelPolicy: 'model-independent loopback SSH count-budget eviction and history recovery' },
context => verifyResourceBudget(context, { ssh: true }));

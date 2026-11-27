import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { verifyResourceBudget } from './resource-budget-runner.mjs';

// RSS belongs to the remote app-server, not its SSH client or Gateway wrapper.
await runIntegration(import.meta.url, { testId: 'gateway-ssh-memory-budget', tier: 'full-integration',
  modelPolicy: 'model-independent loopback SSH RSS-budget eviction and active-client protection' },
context => verifyResourceBudget(context, { ssh: true, memoryOnly: true }));

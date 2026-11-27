import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { runPeerUidProductAcceptance } from '../../e2e/harness/peer-uid-container/product-acceptance.mjs';

await runIntegration(import.meta.url, { testId: 'actual-two-uid-explicit-ssh-enrollment-and-revocation', tier: 'platform',
  retainSuccessLogs: true, cleanupTimeoutMs: 30000,
  modelPolicy: 'Actual HTTP browser login and same-origin explicit pin actions, two non-root SSH Native accounts with CapEff=0/NoNewPrivs=1 in an owned network-none container. Deterministic seed Provider only; no paid models, host account changes, managed-account or Windows claim.' }, runPeerUidProductAcceptance);

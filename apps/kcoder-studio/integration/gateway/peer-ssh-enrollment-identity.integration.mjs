import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { runPeerUidEnrollmentIdentity } from '../../e2e/harness/peer-uid-container/enrollment-identity.mjs';

await runIntegration(import.meta.url, { testId: 'actual-ssh-profile-key-replacement-after-authoritative-revocation', tier: 'platform',
  cleanupTimeoutMs: 30000, retainSuccessLogs: true,
  modelPolicy: 'Actual full-cookie Gateway and SSH UID20001 replace only run-owned generated Native key/profile data. Zero Provider calls, no host-account changes, paid models or React/Windows claim.' }, runPeerUidEnrollmentIdentity);

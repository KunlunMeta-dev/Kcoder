import { runE2E } from '../run-context.mjs';
import { startPeerUidNamespace } from './runtime.mjs';

await runE2E(import.meta.url, { testId: 'actual-isolated-two-os-uid-ssh-precheck', tier: 'platform-preparation', retainSuccessLogs: true, cleanupTimeoutMs: 30000,
  modelPolicy: 'Actual two-UID OpenSSH/ProxyCommand/DAC/owned cleanup only. No KCoder or model execution.' }, async context => {
  const fixture = await startPeerUidNamespace(context);
  const users = await fixture.probeUsers();
  const closed = await fixture.close();
  return { actualDifferentContainerUids: users.map(user => user.uid), actualSshTargets: 2, crossHomeReadDeniedBothDirections: true,
    rootExecutablesNotWritable: true, originalContainerRemoved: true, originalAccountsRetired: closed.originalAccountsRetired, productNativeAcceptance: false, models: 0 };
});

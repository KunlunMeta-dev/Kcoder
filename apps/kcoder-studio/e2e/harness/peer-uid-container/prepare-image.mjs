import { runE2E } from '../run-context.mjs';
import { preparePeerUidImage } from './image.mjs';

await runE2E(import.meta.url, {
  testId: 'owned-peer-uid-container-image-preparation', tier: 'platform-preparation',
  modelPolicy: 'Explicit disposable local Docker OS image build only. No Native, account, SSH server, external model or cross-UID acceptance.',
  retainSuccessLogs: true, cleanupTimeoutMs: 30000,
}, context => preparePeerUidImage(context));

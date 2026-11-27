import { runE2E } from '../run-context.mjs';
import { prepareOfflinePeerUidImage } from './image.mjs';

await runE2E(import.meta.url, {
  testId: 'owned-peer-uid-offline-image-preparation', tier: 'platform-preparation',
  modelPolicy: 'Offline audited system-program rootfs and recursive ELF closure only. No host account/config copy, no container/SSH/Native/model execution.',
  retainSuccessLogs: true, cleanupTimeoutMs: 30000,
}, context => prepareOfflinePeerUidImage(context));

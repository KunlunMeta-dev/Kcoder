import { createIndexedMetadataGate } from '/metadata-gate.mjs';
const gate = createIndexedMetadataGate({ indexedDB });
void gate.run('gateway-profile-index', async lease => {
  lease.assert(); postMessage({ acquired: true }); await new Promise(() => {});
}).catch(() => postMessage({ failure: 'gate_failed' }));

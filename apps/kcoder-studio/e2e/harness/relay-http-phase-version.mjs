import * as v1 from './relay-http-phase-observation.mjs';
import * as v2 from './relay-http-phase-observation-v2.mjs';

// Historical receipts name their original helper separately from this reviewed copy.
const versions = Object.freeze([
  Object.freeze({ module: v1, helperFilename: 'relay-http-phase-observation.mjs',
    helperSha256: '84570ea8522f08e820ba5ef8f88a1d56e640f4f3551b62e1f69d1d9594b325ad',
    historicalExpectedHelperSha256: '7a0bd48c2257691d4fac23d787a1fa4e97c3029e8a0c232b27423d88a50f5628' }),
  Object.freeze({ module: v2, helperFilename: 'relay-http-phase-observation-v2.mjs',
    helperSha256: 'aef623c60b687c31e1608adb6fc2ad649e964a4f207e3fd88c68f07ba723e6a3' }),
]);

export function selectRelayHttpDiagnosticVersion(baseSha256) {
  const version = versions.find(value => value.module.RELAY_HTTP_DIAGNOSTIC_BASE_SHA256 === baseSha256);
  if (!version) throw new Error('Relay HTTP diagnostic source version is not reviewed');
  return Object.freeze({ ...version,
    baseSha256,
    overlaySha256: version.module.RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256,
    apply: version.module.applyRelayPublicHttpDiagnosticOverlay,
  });
}

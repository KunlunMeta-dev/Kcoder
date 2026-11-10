// One-shot, read-only-after-pairing acceptance for the staged Mobile Web release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { open, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { startChromium } from '../harness/chromium.mjs';
import { repoRoot, runE2E, waitFor } from '../harness/run-context.mjs';
import { downloadOwnedCertutil, initializeIsolatedChromiumTrust } from './mobile-route-lan-https-front.mjs';
import { canonicalGatewayConnectionUrl, parseGatewayConnectionRoutes } from '../../shared/gatewayConnectionRoutes.js';

// Chromium DevToolsActivePort must be private even when the host defaults to umask 002.
process.umask(0o077);

const RUN_FLAG = 'KCODER_E2E_CURRENT_RELEASE_ACCEPTANCE';
const CONFIG_ENV = 'KCODER_E2E_CURRENT_RELEASE_CONFIG';
const EXPECTED_VERSION = '0.7.0';
const LAN_CADDY_HOST = '10.31.7.10';
const LAN_CA_PATH = resolve(repoRoot, 'target/evidence/2026/10/19/production-lan-https-20261019/caddy-root.crt');
const LAN_CA_SHA256 = '0481a812913b90be1aae0af1f312225181ba7e69329aa2fedc141267b4400ed6';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RPC_FRAME_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 45_000;
const APPROVED_READONLY_RPC_METHODS = new Set([
  'initialize', 'initialized', 'server/info', 'thread/list', 'workspace/list',
  'runtime.workspaces.list', 'runtime.worktrees.list', 'runtime.models.list',
]);
const SAFE_DIAGNOSTIC_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AssertionError', 'TimeoutError', 'AbortError',
]);
const SAFE_DIAGNOSTIC_ERROR_MESSAGES = new Set([
  'token_fragment_scrub_failed', 'mobile_pairing_session_rejected', 'app_server_initialize_missing',
  'app_server_identity_or_version_mismatch', 'fresh_device_count_not_one',
  'paired_profile_device_identity_mismatch', 'same_profile_reload_failed',
  'mobile_mount_prefix_mismatch', 'mobile_pair_navigation_failed', 'mobile_pair_home_wait_failed',
  'mobile_pair_fragment_audit_failed', 'mobile_pair_initialize_wait_failed', 'mobile_pair_home_lists_wait_failed',
  'rpc_readiness_or_read_only_contract_failed', 'new_device_revoke_reconciliation_failed',
  'new_device_cleanup_unreconciled', 'new_device_cleanup_inventory_failed',
  'multiple_exact_new_device_ids_no_delete', 'new_device_identity_unknown_no_delete',
  'gateway_admin_login_failed', 'gateway_admin_cookie_invalid', 'gateway_pairing_read_failed',
  'gateway_pairing_json_invalid', 'gateway_pairing_token_invalid', 'gateway_pairing_expiry_invalid',
  'gateway_route_descriptor_invalid', 'gateway_route_descriptor_not_strict_https',
  'gateway_pairing_device_inventory_invalid', 'gateway_pairing_inventory_read_failed',
  'gateway_pairing_inventory_json_invalid', 'gateway_pairing_inventory_invalid',
  'gateway_pairing_inventory_response_too_large',
  'strict_https_request_required', 'strict_https_timeout', 'strict_https_request_failed',
  'strict_https_response_failed', 'bounded_response_exceeded',
  'mobile_pairing_link_inputs_invalid', 'mobile_pairing_link_routes_invalid',
  'gateway_target_missing_from_route_descriptor', 'mobile_pairing_link_too_long',
  'one_or_more_origin_lanes_not_passed',
]);

if (process.env[RUN_FLAG] !== '1') {
  throw new Error(`${RUN_FLAG}=1 is required for this private one-shot production acceptance`);
}
const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1';
const requireSandbox = process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === '1';
if (noSandbox === requireSandbox) {
  throw new Error('Set exactly one of KCODER_E2E_CHROMIUM_NO_SANDBOX=1 or KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1');
}
const configPath = process.env[CONFIG_ENV];
if (typeof configPath !== 'string' || !isAbsolute(configPath)) {
  throw new Error(`${CONFIG_ENV} must name an absolute protected JSON file`);
}
const config = await readPrivateConfig(configPath);
validateConfig(config, configPath);

await runE2E(import.meta.url, {
  testId: 'mobile-current-release-public-and-lan-real-browser-acceptance',
  tier: 'manual-live',
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: 'Actual staged Mobile Web and Rust CLI, two isolated strict-TLS Chromium profiles, one new durable pairing per lane, token-fragment scrubbing, same-profile reload and read-only Home/RPC initialize; no model/provider calls, message sends, personal histories, screenshots, browser security overrides, shared development ports, or deployment mutation',
}, async context => {
  const evidence = {
    schemaVersion: 1,
    status: 'incomplete',
    failureStage: null,
    failureErrorName: null,
    failureMessage: null,
    boundary: 'Production Mobile Web public and LAN origins; browser GET preflight precedes all pairing; only synthetic newly paired device IDs may be revoked; no turn/start or history mutation',
    browserSecurity: {
      sandbox: noSandbox ? 'explicit-vm-no-sandbox' : 'required',
      tlsValidation: 'strict; no ignore-certificate-errors or custom web-security flags',
      lanTrust: `isolated NSS only; CA sha256 ${LAN_CA_SHA256}`,
      profiles: 'independent RunContext-owned Chromium profile per origin',
      screenshots: 'disabled',
    },
    release: null,
    lanes: {},
  };
  const deliveries = {};
  const reconciliation = {};
  let finalStatus = 'PARTIAL';
  let evidenceWritten = false;
  let stage = 'release-pin-verification';
  try {
    for (const lane of [config.lanes.public, config.lanes.lan]) {
      context.registerSecret(lane.adminToken);
    }
    evidence.release = await verifyReleasePins(config.release);
    stage = 'lan-ca-read';
    const caPem = await readAndVerifyLanCa();

    for (const laneName of ['public', 'lan']) {
      stage = `lane-${laneName}`;
      const outcome = await acceptLane(context, laneName, config.lanes[laneName], config, caPem);
      evidence.lanes[laneName] = outcome.evidence;
      reconciliation[laneName] = {
        createdDeviceIds: outcome.createdDeviceIds,
        identityResolution: outcome.evidence.device.identityResolution,
        inventoryDeltaCount: outcome.evidence.device.inventoryDeltaCount,
        cleanupAttempted: outcome.evidence.device.cleanupAttempted,
        cleanupReconciledAbsent: outcome.evidence.device.cleanupReconciledAbsent,
      };
      if (outcome.status === 'PASS') {
        deliveries[laneName] = {
          tokenUrl: outcome.tokenUrl,
          pairingExpiresAt: outcome.pairingExpiresAt,
          createdDeviceIds: outcome.createdDeviceIds,
        };
      }
    }

    finalStatus = ['public', 'lan'].every(name => evidence.lanes[name]?.status === 'PASS') ? 'PASS' : 'PARTIAL';
    evidence.status = finalStatus;
    stage = 'protected-delivery-write';
    await writeProtectedDeliveryFile(config.deliveryFile, {
      schemaVersion: 1,
      acceptanceStatus: finalStatus,
      release: evidence.release,
      deviceReconciliation: reconciliation,
      ...(finalStatus === 'PASS' ? { public: deliveries.public, lan: deliveries.lan } : { deliverableLinksWithheld: true }),
    });
    stage = 'lane-results';
    if (finalStatus !== 'PASS') {
      evidence.status = 'FAIL';
      evidence.failureClass = 'one_or_more_origin_lanes_not_passed';
      recordSafeFailure(evidence, stage, new Error('one_or_more_origin_lanes_not_passed'));
      await context.writeArtifactJson('mobile-current-release-acceptance.json', evidence);
      evidenceWritten = true;
      throw new Error('one_or_more_origin_lanes_not_passed');
    }
    stage = 'acceptance-artifact-write';
    await context.writeArtifactJson('mobile-current-release-acceptance.json', evidence);
    evidenceWritten = true;
    return { status: finalStatus, lanes: Object.fromEntries(Object.entries(evidence.lanes).map(([name, lane]) => [name, lane.status])) };
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.failureClass = safeFailureClass(error);
    recordSafeFailure(evidence, stage, error);
    if (!evidenceWritten) await context.writeArtifactJson('mobile-current-release-acceptance.json', evidence).catch(() => undefined);
    throw new Error(`Current release acceptance failed (${evidence.failureClass})`);
  }
});

async function acceptLane(context, laneName, lane, runConfig, caPem) {
  const result = {
    status: 'BLOCKED',
    preflight: { attempted: true, status: null, failureClass: null },
    pairing: {
      attempted: false, sessionStatus: null, tokenFragmentScrubbed: false,
      navigation: {
        pathShape: null, originMatchesExpected: null, withinExpectedBase: null,
        baseMatchesExpectedGateway: null, homeRouteReached: false, fragmentAuditPassed: false,
      },
      cleanupProfileReadEligible: false,
      cleanupProfileReadResolved: false,
    },
    persistence: {
      reloaded: false, sameProfileRoute: false, loginOrConnectError: false,
      sameDeviceAfterReload: false, sessionExpired: false,
    },
    rpc: {
      initializeRequests: 0, initializeSuccesses: 0, serverName: null, serverVersion: null, protocolVersion: null,
      threadListRequests: 0, threadListSuccesses: 0,
      workspaceListRequests: 0, workspaceListSuccesses: 0, readListErrors: 0,
      forbiddenMutationRequests: 0, unapprovedRpcRequests: 0,
    },
    network: { requests: {}, responses: {}, failed: {} },
    device: {
      createdCount: 0, identityResolution: 'unknown', inventoryDeltaCount: null,
      cleanupAttempted: false, cleanupHttpStatus: null, cleanupReconciledAbsent: false,
      inventoryHttpStatuses: [], cleanupFailures: [],
    },
    failureClass: null,
    failureStage: null,
    failureErrorName: null,
    failureMessage: null,
  };
  const output = { evidence: result, status: 'BLOCKED', tokenUrl: null, pairingExpiresAt: null, createdDeviceIds: [] };
  let stage = 'preflight';
  let browser;
  let page;
  let observation;
  let pairing;
  let baselineIds = new Set();
  let baselineEstablished = false;
  let tokenUrl;
  let cleanupAttempted = false;

  try {
    let chromiumEnv;
    if (laneName === 'lan') {
      const certutil = await downloadOwnedCertutil(context);
      const trust = await initializeIsolatedChromiumTrust(context, {
        caCertificatePem: caPem,
        expectedCaSha256: LAN_CA_SHA256,
        certutilPath: certutil,
        nickname: 'kcoder-current-release-lan-ca',
      });
      chromiumEnv = trust.chromiumEnv;
    }
    browser = await startChromium(context, {
      label: `current-release-${laneName}-chromium`,
      profileName: `current-release-${laneName}`,
      executablePath: runConfig.chromiumExecutablePath,
      ...(chromiumEnv ? { env: chromiumEnv } : {}),
    });
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    observation = observePage(page, context, lane);

    const staticUrl = mobileIndexUrl(lane.mobileWebBaseUrl);
    try {
      const response = await page.goto(staticUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      result.preflight.status = response?.status() ?? null;
      if (!response || response.status() !== 200) {
        result.preflight.failureClass = 'mobile_static_get_not_200';
        result.status = 'BLOCKED';
        return output;
      }
      if (new URL(page.url()).protocol !== 'https:') {
        result.preflight.failureClass = 'strict_https_origin_not_retained';
        return output;
      }
      if (new URL(page.url()).origin !== new URL(lane.mobileWebBaseUrl).origin) {
        result.preflight.failureClass = 'mobile_origin_redirected';
        return output;
      }
    } catch (error) {
      result.preflight.failureClass = observation.lastNetworkFailure || safeFailureClass(error);
      recordSafeFailure(result, stage, error);
      result.status = 'BLOCKED';
      return output;
    }

    stage = 'pairing-admin-read';
    pairing = await getAdminPairing(context, lane, caPem, result.device);
    baselineIds = new Set(pairing.deviceIds);
    baselineEstablished = true;
    tokenUrl = buildMobileWebPairingUrl(lane.mobileWebBaseUrl, lane.gatewayAddress, pairing.token, pairing.connectionRoutes);
    context.registerSecret(tokenUrl);
    result.pairing.attempted = true;

    await page.addInitScript(() => {
      const rawFragment = window.location.hash;
      const state = { fragmentPresented: rawFragment.startsWith('#token='), tokenFragmentScrubbed: false };
      Object.defineProperty(window, '__kCurrentReleasePairAudit', { value: state, configurable: false });
      const originalReplaceState = window.history.replaceState.bind(window.history);
      window.history.replaceState = (data, unused, url) => {
        const value = originalReplaceState(data, unused, url);
        if (state.fragmentPresented && window.location.hash === '' && !new URLSearchParams(window.location.search).has('token')) {
          state.tokenFragmentScrubbed = true;
        }
        return value;
      };
    });
    await installPeerRpcObserver(page, observation, context);

    stage = 'mobile-pair-navigation';
    try {
      await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
    } catch {
      recordSafeMobileLocation(result.pairing.navigation, page.url(), lane);
      throw new Error('mobile_pair_navigation_failed');
    }
    recordSafeMobileLocation(result.pairing.navigation, page.url(), lane);

    stage = 'mobile-pair-home';
    try {
      await waitFor(async () => {
        recordSafeMobileLocation(result.pairing.navigation, page.url(), lane);
        const current = new URL(page.url());
        return isHomeRoute(current.pathname, lane.mobileWebBaseUrl) ? true : null;
      }, CONNECT_TIMEOUT_MS, `${laneName} Mobile paired Home route`, 200, context.abortSignal);
    } catch (error) {
      if (error?.cause instanceof Error && error.cause.message === 'mobile_mount_prefix_mismatch') {
        throw new Error('mobile_mount_prefix_mismatch');
      }
      throw new Error('mobile_pair_home_wait_failed');
    }
    result.pairing.navigation.homeRouteReached = true;
    observation.pairedHomeReached = true;
    const firstProfilePath = new URL(page.url()).pathname;
    assertSafeHomeRoute(firstProfilePath, lane.mobileWebBaseUrl);
    stage = 'mobile-pair-fragment-audit';
    let pairAudit;
    try {
      pairAudit = await page.evaluate(() => ({
        fragmentPresented: window.__kCurrentReleasePairAudit?.fragmentPresented === true,
        tokenFragmentScrubbed: window.__kCurrentReleasePairAudit?.tokenFragmentScrubbed === true,
        hashEmpty: window.location.hash === '',
        queryTokenAbsent: !new URLSearchParams(window.location.search).has('token'),
      }));
    } catch {
      throw new Error('mobile_pair_fragment_audit_failed');
    }
    result.pairing.tokenFragmentScrubbed = pairAudit.fragmentPresented && pairAudit.tokenFragmentScrubbed && pairAudit.hashEmpty && pairAudit.queryTokenAbsent;
    result.pairing.navigation.fragmentAuditPassed = result.pairing.tokenFragmentScrubbed;
    if (!result.pairing.tokenFragmentScrubbed) throw new Error('token_fragment_scrub_failed');

    stage = 'initial-rpc-initialize';
    try {
      await waitFor(() => observation.rpc.initializeSuccesses > 0 ? true : null,
        CONNECT_TIMEOUT_MS, `${laneName} actual app-server initialize`, 200, context.abortSignal);
    } catch {
      throw new Error('mobile_pair_initialize_wait_failed');
    }
    stage = 'initial-home-lists';
    try {
      await waitFor(() => observation.rpc.threadListSuccesses > 0 && observation.rpc.workspaceListSuccesses > 0 ? true : null,
        CONNECT_TIMEOUT_MS, `${laneName} initial read-only Home lists`, 200, context.abortSignal);
    } catch {
      throw new Error('mobile_pair_home_lists_wait_failed');
    }
    await flushObservedResponses(observation);
    stage = 'mobile-pair-session-audit';
    result.pairing.sessionStatus = observation.sessionStatuses.find(status => status === 200) ?? null;
    if (result.pairing.sessionStatus !== 200) {
      throw new Error('mobile_pairing_session_rejected');
    }
    if (observation.rpc.initializeSuccesses < 1) throw new Error('app_server_initialize_missing');
    if (observation.rpc.serverName !== 'kcoder-app-server' || observation.rpc.serverVersion !== runConfig.release.version) {
      throw new Error('app_server_identity_or_version_mismatch');
    }

    const persistedDeviceId = await readPairedProfileDeviceId(page, firstProfilePath, lane.mobileWebBaseUrl, lane.gatewayAddress);
    if (persistedDeviceId) {
      context.registerSecret(persistedDeviceId);
      observation.profileDeviceIds.add(persistedDeviceId);
    }
    const freshDeviceIds = identifyExactFreshDevices(baselineIds, observation);
    result.device.createdCount = freshDeviceIds.length;
    result.device.identityResolution = freshDeviceIds.length === 1 ? 'exact' : freshDeviceIds.length > 1 ? 'ambiguous' : 'unknown';
    output.createdDeviceIds = freshDeviceIds;
    if (freshDeviceIds.length !== 1) throw new Error('fresh_device_count_not_one');
    if (!persistedDeviceId || persistedDeviceId !== freshDeviceIds[0]) throw new Error('paired_profile_device_identity_mismatch');

    stage = 'same-profile-reload';
    const initializeSuccessesBeforeReload = observation.rpc.initializeSuccesses;
    const threadListSuccessesBeforeReload = observation.rpc.threadListSuccesses;
    const workspaceListSuccessesBeforeReload = observation.rpc.workspaceListSuccesses;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
    await waitFor(async () => new URL(page.url()).pathname === firstProfilePath ? true : null,
      CONNECT_TIMEOUT_MS, `${laneName} same profile after reload`, 200, context.abortSignal);
    await waitFor(() => observation.rpc.initializeSuccesses > initializeSuccessesBeforeReload ? true : null,
      CONNECT_TIMEOUT_MS, `${laneName} new RPC initialize after reload`, 200, context.abortSignal);
    await waitFor(() => observation.rpc.threadListSuccesses > threadListSuccessesBeforeReload &&
      observation.rpc.workspaceListSuccesses > workspaceListSuccessesBeforeReload ? true : null,
    CONNECT_TIMEOUT_MS, `${laneName} refreshed Home lists after reload`, 200, context.abortSignal);
    await flushObservedResponses(observation);
    const reloadedPath = new URL(page.url()).pathname;
    result.persistence.reloaded = true;
    result.persistence.sameProfileRoute = reloadedPath === firstProfilePath;
    result.persistence.loginOrConnectError = !isHomeRoute(reloadedPath, lane.mobileWebBaseUrl);
    const reloadedDeviceId = await readPairedProfileDeviceId(page, reloadedPath, lane.mobileWebBaseUrl, lane.gatewayAddress);
    const visibleReauthorizationError = await page.locator('[data-testid="reauthorize-active-profile"]').count() > 0;
    if (reloadedDeviceId) context.registerSecret(reloadedDeviceId);
    result.persistence.sameDeviceAfterReload = Boolean(reloadedDeviceId && reloadedDeviceId === persistedDeviceId);
    result.persistence.sessionExpired = observation.sessionStatuses.some(status => status === 401 || status === 403) ||
      observation.refreshStatuses.some(status => status === 401 || status === 403) || visibleReauthorizationError;
    if (!result.persistence.sameProfileRoute || result.persistence.loginOrConnectError || !result.persistence.sameDeviceAfterReload ||
        result.persistence.sessionExpired || new URL(page.url()).hash) {
      throw new Error('same_profile_reload_failed');
    }

    result.rpc = safeRpcSummary(observation.rpc);
    if (result.rpc.initializeSuccesses < 2 || result.rpc.serverName !== 'kcoder-app-server' ||
        result.rpc.serverVersion !== runConfig.release.version || result.rpc.forbiddenMutationRequests !== 0 ||
        result.rpc.unapprovedRpcRequests !== 0 ||
        result.rpc.threadListRequests < 1 || result.rpc.threadListSuccesses < 1 ||
        result.rpc.workspaceListRequests < 1 || result.rpc.workspaceListSuccesses < 1 ||
        observation.httpMutationRequests !== 0 ||
        observation.responses['GET servers 200'] < 1 || observation.responses['GET servers-status 200'] < 1) {
      throw new Error('rpc_readiness_or_read_only_contract_failed');
    }

    stage = 'device-cleanup';
    cleanupAttempted = true;
    const cleanup = await revokeExactFreshDeviceOnce(context, pairing, freshDeviceIds[0], baselineIds, result.device);
    result.device.cleanupAttempted = cleanup.attempted;
    result.device.cleanupReconciledAbsent = cleanup.reconciledAbsent;
    if (!cleanup.reconciledAbsent) throw new Error('new_device_revoke_reconciliation_failed');
    result.network = safeNetworkSummary(observation);
    result.status = 'PASS';
    output.status = 'PASS';
    output.tokenUrl = tokenUrl;
    output.pairingExpiresAt = pairing.expiresAt;
    return output;
  } catch (error) {
    result.failureClass = stage === 'preflight' ? (observation?.lastNetworkFailure || safeFailureClass(error)) : safeFailureClass(error);
    recordSafeFailure(result, stage, error);
    result.status = stage === 'preflight' ? 'BLOCKED' : 'FAIL';
    output.status = result.status;
    if (observation) result.rpc = safeRpcSummary(observation.rpc);
    if (observation) result.network = safeNetworkSummary(observation);
    return output;
  } finally {
    if (pairing && baselineEstablished && !cleanupAttempted) {
      let cleanupStage = 'cleanup-response-settle';
      try {
        await flushObservedResponses(observation);
        if (observation) {
          result.pairing.sessionStatus = observation.sessionStatuses.find(status => status === 200) ??
            observation.sessionStatuses.at(-1) ?? null;
        }
        cleanupStage = 'cleanup-device-identification';
        if (page && observation) {
          const profileDevice = await readCurrentExpectedProfileDeviceId(page, lane, result.pairing);
          if (profileDevice) {
            context.registerSecret(profileDevice);
            observation.profileDeviceIds.add(profileDevice);
            result.pairing.cleanupProfileReadResolved = true;
          }
        }
        const fresh = identifyExactFreshDevices(baselineIds, observation);
        if (fresh.length === 1) {
          output.createdDeviceIds = fresh;
          result.device.createdCount = 1;
          result.device.identityResolution = 'exact';
          cleanupAttempted = true;
          cleanupStage = 'cleanup-revoke-and-inventory';
          const cleanup = await revokeExactFreshDeviceOnce(context, pairing, fresh[0], baselineIds, result.device);
          result.device.cleanupAttempted = cleanup.attempted;
          result.device.cleanupReconciledAbsent = cleanup.reconciledAbsent;
          if (!cleanup.reconciledAbsent) {
            result.status = 'FAIL';
            const error = new Error('new_device_cleanup_unreconciled');
            recordCleanupFailure(result.device, cleanupStage, error);
            if (!result.failureStage) {
              recordSafeFailure(result, cleanupStage, error);
              result.failureClass = 'new_device_cleanup_unreconciled';
            }
            output.status = 'FAIL';
          }
        } else {
          output.createdDeviceIds = fresh;
          result.device.createdCount = fresh.length;
          result.device.identityResolution = fresh.length > 1 ? 'ambiguous' : 'unknown';
          cleanupStage = 'cleanup-inventory-delta';
          result.device.inventoryDeltaCount = await readNewDeviceDeltaCount(pairing, baselineIds, result.device);
          result.status = 'FAIL';
          const message = fresh.length > 1 ? 'multiple_exact_new_device_ids_no_delete' : 'new_device_identity_unknown_no_delete';
          if (!result.failureStage) {
            const error = new Error(message);
            recordSafeFailure(result, cleanupStage, error);
            result.failureClass = message;
          }
          output.status = 'FAIL';
        }
      } catch (error) {
        result.device.cleanupReconciledAbsent = false;
        recordCleanupFailure(result.device, cleanupStage, error);
        if (result.pairing.attempted) {
          result.status = 'FAIL';
          if (!result.failureStage) {
            recordSafeFailure(result, cleanupStage, error);
            result.failureClass = 'new_device_cleanup_inventory_failed';
          }
          output.status = 'FAIL';
        }
      }
    }
    if (observation) result.network = safeNetworkSummary(observation);
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function observePage(page, context, lane) {
  const allowedOrigins = new Set([
    new URL(lane.mobileWebBaseUrl).origin,
    new URL(lane.gatewayAddress).origin,
  ]);
  const observation = {
    requests: {}, responses: {}, failed: {}, lastNetworkFailure: null,
    sessionStatuses: [], refreshStatuses: [], sessionDeviceIds: new Set(), profileDeviceIds: new Set(), responseJobs: new Set(),
    rpc: {
      initializeRequests: 0, initializeSuccesses: 0, initializeErrors: 0,
      serverName: null, serverVersion: null, protocolVersion: null,
      threadListRequests: 0,
      threadListSuccesses: 0,
      workspaceListRequests: 0,
      workspaceListSuccesses: 0,
      readListErrors: 0,
      forbiddenMutationRequests: 0, unapprovedRpcRequests: 0,
    },
    peerHttpRequests: {},
    peerHttpRequestCount: 0,
    peerHttpMutationRequests: 0,
  };
  const forbiddenMethods = new Set([
    'turn/start', 'thread/start', 'thread/delete', 'thread/rename', 'thread/read', 'thread/read/indexed',
    'thread/creation/read', 'thread/presence/read', 'thread/resume', 'thread/history/refresh',
    'thread/archive', 'thread/unarchive', 'turn/steer', 'turn/cancel',
    'thread/metadata/update', 'thread/rollback', 'thread/fork', 'turn/interrupt', 'agent/steer',
    'settings/write', 'workspace/write', 'workspace/delete', 'workspace/create', 'workspace/open', 'workspace/rename',
    'runtime.workspaces.rename', 'runtime.workspaces.delete', 'runtime.workspaces.create',
    'runtime.worktrees.conversations.link', 'runtime.worktrees.create', 'runtime.worktrees.delete',
    'runtime.workspaces.prepareV2', 'runtime.workspaces.openV2', 'runtime.worktrees.prepareV2',
    'terminal/start', 'terminal/write', 'terminal/close',
  ]);
  observation.httpMutationRequests = 0;

  page.on('pageerror', () => { observation.failed.pageerror = (observation.failed.pageerror || 0) + 1; });
  page.on('requestfailed', request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (!allowedOrigins.has(url.origin)) return;
    const failure = classifyNetworkFailure(request.failure()?.errorText || '');
    observation.failed[failure] = (observation.failed[failure] || 0) + 1;
    observation.lastNetworkFailure = failure;
  });
  page.on('request', request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (!allowedOrigins.has(url.origin)) return;
    const category = classifyPath(url.pathname);
    const key = `${request.method()} ${category}`;
    observation.requests[key] = (observation.requests[key] || 0) + 1;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        !['mobile-session', 'mobile-session-refresh', 'mobile-p2p-offer'].includes(category)) {
      observation.httpMutationRequests += 1;
    }
  });
  page.on('response', response => {
    const job = observeResponse(response).catch(() => undefined).finally(() => observation.responseJobs.delete(job));
    observation.responseJobs.add(job);
  });
  page.on('websocket', socket => {
    let url;
    try { url = new URL(socket.url()); } catch { return; }
    if (classifyPath(url.pathname) !== 'rpc') return;
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : null;
    if (!protocol) return;
    url.protocol = protocol;
    if (!allowedOrigins.has(url.origin)) return;
    const socketPendingRpc = new Map();
    socket.on('framesent', frame => observeRpcFrame(frame?.payload, socketPendingRpc, observation.rpc, forbiddenMethods, 'sent'));
    socket.on('framereceived', frame => observeRpcFrame(frame?.payload, socketPendingRpc, observation.rpc, forbiddenMethods, 'received'));
  });

  async function observeResponse(response) {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (!allowedOrigins.has(url.origin)) return;
    const request = response.request();
    const category = classifyPath(url.pathname);
    const key = `${request.method()} ${category} ${response.status()}`;
    observation.responses[key] = (observation.responses[key] || 0) + 1;
    const isSessionPost = category === 'mobile-session' && request.method() === 'POST';
    const isRefreshPost = category === 'mobile-session-refresh' && request.method() === 'POST';
    if (isRefreshPost) observation.refreshStatuses.push(response.status());
    else if (isSessionPost) observation.sessionStatuses.push(response.status());
    else return;
    if (response.status() < 200 || response.status() >= 300) return;
    const contentLength = Number(response.headers()['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) return;
    const bytes = await response.body();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return;
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); } catch { return; }
    for (const field of ['accessToken', 'refreshToken', 'rpcToken']) {
      if (typeof payload?.[field] === 'string') context.registerSecret(payload[field]);
    }
    if (typeof payload?.deviceId === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(payload.deviceId)) {
      context.registerSecret(payload.deviceId);
      if (isSessionPost) observation.sessionDeviceIds.add(payload.deviceId);
    }
  }

  return observation;
}

function observeRpcFrame(payload, pending, rpc, forbiddenMethods, direction) {
  if (direction === 'received' && pending.size === 0) return;
  if (typeof payload !== 'string' || payload.length > MAX_RPC_FRAME_BYTES) return;
  let message;
  try { message = JSON.parse(payload); } catch { return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (direction === 'sent' && typeof message.method === 'string') {
    const method = message.method;
    if (method === 'initialize') rpc.initializeRequests += 1;
    if (method === 'thread/list') rpc.threadListRequests += 1;
    if (method === 'workspace/list' || method === 'runtime.workspaces.list' || method === 'runtime.worktrees.list') {
      rpc.workspaceListRequests += 1;
    }
    if (forbiddenMethods.has(method)) rpc.forbiddenMutationRequests += 1;
    if (!APPROVED_READONLY_RPC_METHODS.has(method)) rpc.unapprovedRpcRequests += 1;
    if (message.id !== undefined && message.id !== null &&
        ['initialize', 'thread/list', 'workspace/list', 'runtime.workspaces.list', 'runtime.worktrees.list'].includes(method)) {
      pending.set(String(message.id), method);
    }
    return;
  }
  if (direction !== 'received' || message.id === undefined || message.id === null) return;
  const method = pending.get(String(message.id));
  if (!method) return;
  pending.delete(String(message.id));
  if (message.error) {
    if (method === 'initialize') rpc.initializeErrors += 1;
    else rpc.readListErrors += 1;
    return;
  }
  if (method === 'initialize') {
    rpc.initializeSuccesses += 1;
    if (typeof message.result?.serverInfo?.name === 'string') rpc.serverName = message.result.serverInfo.name;
    if (typeof message.result?.serverInfo?.version === 'string') rpc.serverVersion = message.result.serverInfo.version;
    if (typeof message.result?.protocolVersion === 'string') rpc.protocolVersion = message.result.protocolVersion;
  } else if (message.result !== undefined && message.result !== null) {
    if (method === 'thread/list') rpc.threadListSuccesses += 1;
    else rpc.workspaceListSuccesses += 1;
  } else {
    rpc.readListErrors += 1;
  }
}

function safeRpcSummary(rpc) {
  return {
    initializeRequests: rpc.initializeRequests,
    initializeSuccesses: rpc.initializeSuccesses,
    serverName: rpc.serverName,
    serverVersion: rpc.serverVersion,
    protocolVersion: rpc.protocolVersion,
    threadListRequests: rpc.threadListRequests,
    threadListSuccesses: rpc.threadListSuccesses,
    workspaceListRequests: rpc.workspaceListRequests,
    workspaceListSuccesses: rpc.workspaceListSuccesses,
    readListErrors: rpc.readListErrors,
    forbiddenMutationRequests: rpc.forbiddenMutationRequests,
    unapprovedRpcRequests: rpc.unapprovedRpcRequests,
  };
}

function safeNetworkSummary(observation) {
  return {
    requests: { ...observation.requests },
    responses: { ...observation.responses },
    failed: { ...observation.failed },
    httpMutationRequests: observation.httpMutationRequests,
    peerHttpRequests: { ...observation.peerHttpRequests },
    peerHttpRequestCount: observation.peerHttpRequestCount,
    peerHttpMutationRequests: observation.peerHttpMutationRequests,
  };
}

async function installPeerRpcObserver(page, observation, context) {
  const forbiddenMethods = new Set([
    'turn/start', 'thread/start', 'thread/delete', 'thread/rename',
    'thread/archive', 'thread/unarchive', 'turn/steer', 'turn/cancel',
    'workspace/write', 'workspace/delete', 'workspace/create', 'workspace/open', 'workspace/rename',
    'runtime.workspaces.prepareV2', 'runtime.workspaces.openV2', 'runtime.worktrees.prepareV2',
    'terminal/start', 'terminal/write', 'terminal/close',
  ]);
  await page.exposeFunction('__kCurrentReleaseRpcObservation', value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'peer-auth-response-secrets') {
      for (const field of ['accessToken', 'refreshToken', 'rpcToken']) {
        if (typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= MAX_RESPONSE_BYTES) {
          context.registerSecret(value[field]);
        }
      }
      if (typeof value.deviceId === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(value.deviceId)) {
        context.registerSecret(value.deviceId);
        if (value.method === 'POST' && value.category === 'mobile-session') {
          observation.sessionDeviceIds.add(value.deviceId);
        }
      }
    } else if (value.type === 'peer-http-request' && typeof value.method === 'string' && typeof value.category === 'string') {
      observation.peerHttpRequestCount += 1;
      const key = `${value.method} ${value.category}`;
      observation.peerHttpRequests[key] = (observation.peerHttpRequests[key] || 0) + 1;
      if (value.mutation === true) {
        observation.peerHttpMutationRequests += 1;
        observation.httpMutationRequests += 1;
      }
    } else if (value.type === 'peer-http-response' && typeof value.method === 'string' &&
        typeof value.category === 'string' && Number.isInteger(value.status)) {
      const key = `${value.method} ${value.category} ${value.status}`;
      observation.responses[key] = (observation.responses[key] || 0) + 1;
      if (value.category === 'mobile-session' && value.method === 'POST') observation.sessionStatuses.push(value.status);
      if (value.category === 'mobile-session-refresh' && value.method === 'POST') observation.refreshStatuses.push(value.status);
    } else if (value.type === 'request' && typeof value.method === 'string' && value.method.length <= 128) {
      const method = value.method;
      if (method === 'initialize') observation.rpc.initializeRequests += 1;
      if (method === 'thread/list') observation.rpc.threadListRequests += 1;
      if (method === 'workspace/list' || method === 'runtime.workspaces.list' || method === 'runtime.worktrees.list') {
        observation.rpc.workspaceListRequests += 1;
      }
      if (forbiddenMethods.has(method)) observation.rpc.forbiddenMutationRequests += 1;
      if (!APPROVED_READONLY_RPC_METHODS.has(method)) observation.rpc.unapprovedRpcRequests += 1;
    } else if (value.type === 'read-list-result' && typeof value.method === 'string') {
      const target = value.method === 'thread/list' ? 'threadListSuccesses' : 'workspaceListSuccesses';
      if (value.success === true) observation.rpc[target] += 1;
      else observation.rpc.readListErrors += 1;
    } else if (value.type === 'initialize-result') {
      if (value.success === true) observation.rpc.initializeSuccesses += 1;
      else observation.rpc.initializeErrors += 1;
      if (typeof value.serverVersion === 'string' && /^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(value.serverVersion)) {
        observation.rpc.serverVersion = value.serverVersion;
      }
      if (value.serverName === 'kcoder-app-server') observation.rpc.serverName = value.serverName;
      if (typeof value.protocolVersion === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value.protocolVersion)) {
        observation.rpc.protocolVersion = value.protocolVersion;
      }
    }
  });
  await page.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    if (typeof NativePeerConnection !== 'function') return;
    const maxRpcBytes = 2 * 1024 * 1024;
    const maxAuthResponseBytes = 64 * 1024;
    const report = value => {
      try { void window.__kCurrentReleaseRpcObservation(value); } catch {}
    };
    const decodeBase64Chunk = data => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const registerAuthResponseSecrets = assembly => {
      if (assembly.received !== assembly.expected) return;
      const bytes = new Uint8Array(assembly.received);
      let offset = 0;
      for (const chunk of assembly.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const values = { type: 'peer-auth-response-secrets' };
      for (const field of ['accessToken', 'refreshToken', 'rpcToken']) {
        if (typeof payload[field] === 'string' && payload[field].length > 0 && payload[field].length <= 4096) {
          values[field] = payload[field];
        }
      }
      if (typeof payload.deviceId === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(payload.deviceId)) {
        values.deviceId = payload.deviceId;
      }
      if (assembly.method === 'POST' && assembly.category === 'mobile-session') {
        values.method = assembly.method;
        values.category = assembly.category;
      }
      if (Object.keys(values).length > 1) report(values);
    };
    const parseRpcMessage = (raw, state, direction, wsId) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (direction === 'sent' && typeof message.method === 'string') {
        report({ type: 'request', method: message.method });
        if (message.method === 'initialize' && message.id !== undefined && message.id !== null) {
          state.pendingInitialize = { wsId, rpcId: String(message.id) };
        }
        if (message.id !== undefined && message.id !== null &&
            ['thread/list', 'workspace/list', 'runtime.workspaces.list', 'runtime.worktrees.list'].includes(message.method)) {
          state.pendingReadRequests.set(`${wsId}:${String(message.id)}`, message.method);
        }
      } else if (direction === 'received') {
        const pending = state.pendingInitialize;
        if (pending && pending.wsId === wsId && message.id !== undefined && String(message.id) === pending.rpcId) {
          report({
            type: 'initialize-result',
            success: !message.error && Boolean(message.result),
            serverName: message.result?.serverInfo?.name,
            serverVersion: message.result?.serverInfo?.version,
            protocolVersion: message.result?.protocolVersion,
          });
          state.pendingInitialize = null;
        }
        if (message.id !== undefined && message.id !== null) {
          const key = `${wsId}:${String(message.id)}`;
          const method = state.pendingReadRequests.get(key);
          if (method) {
            state.pendingReadRequests.delete(key);
            report({ type: 'read-list-result', method, success: !message.error && message.result !== undefined && message.result !== null });
          }
        }
      }
    };
    const inspectFrame = (raw, direction, state) => {
      if (typeof raw !== 'string' || raw.length > maxRpcBytes) return;
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.version !== 1 || typeof frame.type !== 'string') return;
      if (direction === 'sent' && frame.type === 'http.request.start') {
        const method = typeof frame.method === 'string' && frame.method.length <= 16 ? frame.method.toUpperCase() : 'OTHER';
        const rawPath = typeof frame.path === 'string' && frame.path.length <= 4096 ? frame.path.split('?', 1)[0] : '';
        const path = rawPath.replace(/^\/g\/[A-Za-z0-9_-]{1,64}(?=\/|$)/, '') || '/';
        let category = 'other';
        if (path === '/api/mobile/session') category = 'mobile-session';
        else if (path === '/api/mobile/session/refresh') category = 'mobile-session-refresh';
        else if (path === '/api/mobile/p2p/offer') category = 'mobile-p2p-offer';
        else if (path === '/api/mobile/p2p') category = 'mobile-p2p-config';
        else if (path === '/api/servers/status') category = 'servers-status';
        else if (path === '/api/servers') category = 'servers';
        else if (path === '/api/workspaces') category = 'workspaces';
        else if (path.startsWith('/api/')) category = 'api-other';
        else if (path === '/rpc') category = 'rpc';
        const readonlyMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method);
        const allowedControlPost = method === 'POST' && ['mobile-session', 'mobile-session-refresh', 'mobile-p2p-offer'].includes(category);
        if (typeof frame.id === 'string') state.pendingHttp.set(frame.id, { method, category });
        report({ type: 'peer-http-request', method, category, mutation: !readonlyMethod && !allowedControlPost });
        return;
      }
      if (direction === 'received' && frame.type === 'http.response.start' && typeof frame.id === 'string') {
        const request = state.pendingHttp.get(frame.id);
        if (request) {
          state.pendingHttp.delete(frame.id);
          const status = Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 ? frame.status : 0;
          report({ type: 'peer-http-response', ...request, status });
          if (request.method === 'POST' && ['mobile-session', 'mobile-session-refresh'].includes(request.category) &&
              status >= 200 && status < 300 && Number.isSafeInteger(frame.bodyLength) &&
              frame.bodyLength > 0 && frame.bodyLength <= maxAuthResponseBytes && state.pendingAuthBodies.size < 4) {
            state.pendingAuthBodies.set(frame.id, {
              method: request.method,
              category: request.category,
              expected: frame.bodyLength,
              received: 0,
              sequence: 0,
              chunks: [],
            });
          }
        }
        return;
      }
      if (direction === 'received' && frame.type === 'http.response.chunk') {
        const assembly = typeof frame.id === 'string' ? state.pendingAuthBodies.get(frame.id) : null;
        if (assembly) {
          if (frame.seq !== assembly.sequence || assembly.sequence >= 32 || typeof frame.data !== 'string' || frame.data.length > maxAuthResponseBytes * 2) {
            state.pendingAuthBodies.delete(frame.id);
            return;
          }
          let bytes;
          try { bytes = decodeBase64Chunk(frame.data); } catch {
            state.pendingAuthBodies.delete(frame.id);
            return;
          }
          if (bytes.byteLength === 0 || assembly.received + bytes.byteLength > assembly.expected ||
              assembly.received + bytes.byteLength > maxAuthResponseBytes) {
            state.pendingAuthBodies.delete(frame.id);
            return;
          }
          assembly.sequence += 1;
          assembly.received += bytes.byteLength;
          assembly.chunks.push(bytes);
        }
        return;
      }
      if (direction === 'received' && frame.type === 'http.response.end') {
        const assembly = typeof frame.id === 'string' ? state.pendingAuthBodies.get(frame.id) : null;
        if (assembly) {
          state.pendingAuthBodies.delete(frame.id);
          registerAuthResponseSecrets(assembly);
        }
        return;
      }
      if (direction === 'sent' && frame.type === 'ws.open' && typeof frame.id === 'string') {
        state.websocketIds.add(frame.id);
        state.currentWsId = frame.id;
        return;
      }
      if (direction === 'received' && frame.type === 'ws.opened' && typeof frame.id === 'string') {
        state.websocketIds.add(frame.id);
        state.currentWsId = frame.id;
        return;
      }
      if (!state.websocketIds.has(frame.id) || typeof frame.messageId !== 'string') return;
      const key = `${direction}:${frame.id}:${frame.messageId}`;
      if (frame.type === 'ws.message.start') {
        const isInitializeResponse = direction === 'received' && state.pendingInitialize?.wsId === frame.id;
        const hasPendingReadResponse = direction === 'received' && [...state.pendingReadRequests.keys()].some(key => key.startsWith(`${frame.id}:`));
        const shouldInspect = direction === 'sent' || isInitializeResponse || hasPendingReadResponse;
        if (!shouldInspect || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > maxRpcBytes) return;
        state.assemblies.set(key, { bytes: [], byteLength: 0, expected: frame.byteLength, sequence: 0 });
        return;
      }
      const assembly = state.assemblies.get(key);
      if (!assembly) return;
      if (frame.type === 'ws.message.chunk') {
        if (frame.seq !== assembly.sequence || typeof frame.data !== 'string' || frame.data.length > maxRpcBytes * 2) {
          state.assemblies.delete(key);
          return;
        }
        let decoded;
        try {
          const value = atob(frame.data);
          decoded = new Uint8Array(value.length);
          for (let index = 0; index < value.length; index += 1) decoded[index] = value.charCodeAt(index);
        } catch {
          state.assemblies.delete(key);
          return;
        }
        assembly.sequence += 1;
        assembly.byteLength += decoded.byteLength;
        if (assembly.byteLength > assembly.expected || assembly.byteLength > maxRpcBytes) {
          state.assemblies.delete(key);
          return;
        }
        assembly.bytes.push(decoded);
        return;
      }
      if (frame.type !== 'ws.message.end') return;
      state.assemblies.delete(key);
      if (assembly.byteLength !== assembly.expected) return;
      const bytes = new Uint8Array(assembly.byteLength);
      let offset = 0;
      for (const chunk of assembly.bytes) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      parseRpcMessage(new TextDecoder().decode(bytes), state, direction, frame.id);
    };
    const attachDataChannel = channel => {
      if (!channel || channel.__kCurrentReleaseObserved) return;
      try { Object.defineProperty(channel, '__kCurrentReleaseObserved', { value: true }); } catch {}
      const state = {
        websocketIds: new Set(), currentWsId: null, pendingInitialize: null,
        pendingReadRequests: new Map(), pendingHttp: new Map(), pendingAuthBodies: new Map(), assemblies: new Map(),
      };
      const send = channel.send.bind(channel);
      try {
        channel.send = data => {
          inspectFrame(data, 'sent', state);
          return send(data);
        };
      } catch {}
      channel.addEventListener('message', event => inspectFrame(event.data, 'received', state));
    };
    try {
      window.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(target, args, newTarget) {
          const connection = Reflect.construct(target, args, newTarget);
          const createDataChannel = connection.createDataChannel.bind(connection);
          connection.createDataChannel = (...channelArgs) => {
            const channel = createDataChannel(...channelArgs);
            attachDataChannel(channel);
            return channel;
          };
          connection.addEventListener('datachannel', event => attachDataChannel(event.channel));
          return connection;
        },
      });
    } catch {}
  });
}

async function flushObservedResponses(observation) {
  while (observation.responseJobs.size) await Promise.all([...observation.responseJobs]);
}

function classifyPath(pathname) {
  const path = pathname.replace(/^\/g\/[A-Za-z0-9_-]{1,64}(?=\/|$)/, '') || '/';
  if (path.endsWith('/api/mobile/session')) return 'mobile-session';
  if (path.endsWith('/api/mobile/session/refresh')) return 'mobile-session-refresh';
  if (path.endsWith('/api/mobile/p2p/offer')) return 'mobile-p2p-offer';
  if (path.endsWith('/api/mobile/p2p')) return 'mobile-p2p-config';
  if (path.endsWith('/api/servers/status')) return 'servers-status';
  if (path.endsWith('/api/servers')) return 'servers';
  if (path.endsWith('/api/workspaces')) return 'workspaces';
  if (path.endsWith('/rpc')) return 'rpc';
  if (path === '/' || path.endsWith('/mobile/') || path.endsWith('/mobile/index.html')) return 'mobile-static';
  if (/\.(?:js|css|png|svg|woff2?)$/i.test(path)) return 'mobile-static-asset';
  return 'other';
}

function classifyNetworkFailure(message) {
  if (/ERR_NETWORK_CHANGED/i.test(message)) return 'ERR_NETWORK_CHANGED';
  if (/ERR_CERT_|CERTIFICATE/i.test(message)) return 'tls_validation_failed';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return 'dns_failed';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) return 'connection_refused';
  return 'request_failed';
}

async function getAdminPairing(context, lane, caPem, deviceEvidence) {
  const base = parseStrictHttpsUrl(lane.gatewayAdminBaseUrl);
  const adminCaPem = selectAdminCaForUrl(base, caPem);
  const prefix = base.pathname.replace(/\/+$/, '');
  const loginUrl = new URL(`${prefix}/login`, base.origin);
  loginUrl.searchParams.set('token', lane.adminToken);
  loginUrl.searchParams.set('returnTo', `${prefix || ''}/`);
  const login = await strictHttpsRequest(loginUrl, { redirect: 'manual', caPem: adminCaPem });
  if (login.status !== 303) throw new Error('gateway_admin_login_failed');
  const rawCookie = login.headers['set-cookie'];
  const cookieLine = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const cookie = typeof cookieLine === 'string' ? cookieLine.split(';', 1)[0] : '';
  if (!/^kcoder_studio_session=[A-Za-z0-9_-]{32,128}$/.test(cookie)) throw new Error('gateway_admin_cookie_invalid');
  context.registerSecret(cookie);

  const pairingUrl = new URL(`${prefix}/api/mobile/pairing`, base.origin);
  const response = await strictHttpsRequest(pairingUrl, { headers: { cookie }, caPem: adminCaPem });
  recordInventoryHttpStatus(deviceEvidence, response.status);
  if (response.status !== 200 || response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('gateway_pairing_read_failed');
  let payload;
  try { payload = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('gateway_pairing_json_invalid'); }
  if (typeof payload?.token !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(payload.token)) throw new Error('gateway_pairing_token_invalid');
  if (!Number.isSafeInteger(payload.expiresAt)) throw new Error('gateway_pairing_expiry_invalid');
  context.registerSecret(payload.token);
  const routes = payload.connectionRoutes == null ? undefined : parseGatewayConnectionRoutes(payload.connectionRoutes);
  if (payload.connectionRoutes != null && !routes) throw new Error('gateway_route_descriptor_invalid');
  if (routes && routes.endpoints.some(endpoint => {
    try { parseStrictHttpsUrl(endpoint.url); return false; } catch { return true; }
  })) throw new Error('gateway_route_descriptor_not_strict_https');
  if (routes) context.registerSecret(JSON.stringify(routes));
  if (!Array.isArray(payload.devices) || payload.devices.some(device => !device || typeof device.id !== 'string')) {
    throw new Error('gateway_pairing_device_inventory_invalid');
  }
  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    connectionRoutes: routes,
    cookie,
    adminOrigin: base.origin,
    adminPrefix: prefix,
    adminCaPem,
    deviceIds: payload.devices.map(device => device.id),
  };
}

function selectAdminCaForUrl(adminBaseUrl, lanCaPem) {
  const url = adminBaseUrl instanceof URL ? adminBaseUrl : parseStrictHttpsUrl(adminBaseUrl);
  if (url.hostname !== LAN_CADDY_HOST) throw new Error('gateway_admin_host_not_verified_direct_gateway');
  if (typeof lanCaPem !== 'string' || lanCaPem.length === 0) throw new Error('gateway_admin_lan_ca_missing');
  return lanCaPem;
}

function identifyExactFreshDevices(baselineIds, observation) {
  const capturedIds = new Set([...observation.sessionDeviceIds, ...observation.profileDeviceIds]);
  return [...capturedIds].filter(id => !baselineIds.has(id));
}

async function readPairedProfileDeviceId(page, absolutePath, mobileWebBaseUrl, gatewayAddress) {
  const profileId = profileIdFromHomePath(absolutePath, mobileWebBaseUrl);
  const expectedGatewayUrl = canonicalGatewayConnectionUrl(gatewayAddress);
  if (!profileId || !expectedGatewayUrl) return null;
  return page.evaluate(({ expectedProfileId, expectedGatewayUrl }) => {
    try {
      const raw = window.localStorage.getItem('kcoder-studio-mobile.gateway-profiles.v2');
      if (!raw) return null;
      const index = JSON.parse(raw);
      if (index?.activeId !== expectedProfileId || !Array.isArray(index.profiles)) return null;
      const profiles = index.profiles.filter(profile => {
        if (profile?.id !== expectedProfileId || typeof profile.baseUrl !== 'string') return false;
        try {
          const url = new URL(profile.baseUrl);
          return url.protocol === 'https:' && `${url.origin}${url.pathname.replace(/\/+$/, '')}` === expectedGatewayUrl;
        } catch { return false; }
      });
      if (profiles.length !== 1 || typeof profiles[0].deviceId !== 'string' ||
          !/^[A-Za-z0-9-]{16,128}$/.test(profiles[0].deviceId)) return null;
      return profiles[0].deviceId;
    } catch { return null; }
  }, { expectedProfileId: profileId, expectedGatewayUrl });
}

async function readCurrentExpectedProfileDeviceId(page, lane, pairingEvidence) {
  const currentUrl = page.url();
  const location = safeMobileLocation(currentUrl, lane);
  recordSafeMobileLocation(pairingEvidence.navigation, currentUrl, lane);
  const eligible = location.originMatchesExpected && location.withinExpectedBase &&
    location.baseMatchesExpectedGateway;
  pairingEvidence.cleanupProfileReadEligible = eligible;
  if (!eligible) return null;
  const expectedGatewayUrl = canonicalGatewayConnectionUrl(lane.gatewayAddress);
  if (!expectedGatewayUrl) return null;
  const mobileBase = new URL(lane.mobileWebBaseUrl);
  const expectedMobileBasePath = normalizePathname(mobileBase.pathname);
  try {
    return await page.evaluate(({ expectedGatewayUrl, expectedOrigin, expectedMobileBasePath }) => {
      try {
        if (window.location.origin !== expectedOrigin ||
            !(window.location.pathname === expectedMobileBasePath ||
              window.location.pathname.startsWith(`${expectedMobileBasePath}/`))) return null;
        const raw = window.localStorage.getItem('kcoder-studio-mobile.gateway-profiles.v2');
        if (!raw) return null;
        const index = JSON.parse(raw);
        if (typeof index?.activeId !== 'string' || !Array.isArray(index.profiles)) return null;
        const matches = index.profiles.filter(profile => {
          if (profile?.id !== index.activeId || typeof profile.baseUrl !== 'string') return false;
          try {
            const url = new URL(profile.baseUrl);
            return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
              `${url.origin}${url.pathname.replace(/\/+$/, '')}` === expectedGatewayUrl;
          } catch { return false; }
        });
        if (matches.length !== 1 || typeof matches[0].deviceId !== 'string' ||
            !/^[A-Za-z0-9-]{16,128}$/.test(matches[0].deviceId)) return null;
        return matches[0].deviceId;
      } catch { return null; }
    }, {
      expectedGatewayUrl,
      expectedOrigin: mobileBase.origin,
      expectedMobileBasePath,
    });
  } catch {
    return null;
  }
}

async function readDeviceInventory(pairing, deviceEvidence) {
  const url = new URL(`${pairing.adminPrefix}/api/mobile/pairing`, pairing.adminOrigin);
  const response = await strictHttpsRequest(url, { headers: { cookie: pairing.cookie }, caPem: pairing.adminCaPem });
  recordInventoryHttpStatus(deviceEvidence, response.status);
  if (response.status !== 200) {
    const error = new Error('gateway_pairing_inventory_read_failed');
    error.httpStatus = response.status;
    throw error;
  }
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('gateway_pairing_inventory_response_too_large');
  let payload;
  try { payload = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('gateway_pairing_inventory_json_invalid'); }
  if (!Array.isArray(payload?.devices) || payload.devices.some(device => typeof device?.id !== 'string')) {
    throw new Error('gateway_pairing_inventory_invalid');
  }
  return payload.devices.map(device => device.id);
}

async function readNewDeviceDeltaCount(pairing, baselineIds, deviceEvidence) {
  const current = await readDeviceInventory(pairing, deviceEvidence);
  return current.filter(id => !baselineIds.has(id)).length;
}

async function revokeExactFreshDeviceOnce(context, pairing, deviceId, baselineIds, deviceEvidence) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(deviceId) || baselineIds.has(deviceId)) {
    return { attempted: false, reconciledAbsent: false };
  }
  context.registerSecret(deviceId);
  const url = new URL(`${pairing.adminPrefix}/api/mobile/pairing/devices/${encodeURIComponent(deviceId)}`, pairing.adminOrigin);
  const body = '{}';
  deviceEvidence.cleanupAttempted = true;
  try {
    const response = await strictHttpsRequest(url, {
      method: 'DELETE',
      caPem: pairing.adminCaPem,
      headers: {
        cookie: pairing.cookie,
        origin: pairing.adminOrigin,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    deviceEvidence.cleanupHttpStatus = response.status;
  } catch (error) {
    // Resolve a lost receipt with one inventory read; never replay the DELETE.
    recordCleanupFailure(deviceEvidence, 'device-revoke-dispatch', error);
  }
  const remainingIds = await readInventoryForCleanupReconciliation(pairing, deviceEvidence);
  return { attempted: true, reconciledAbsent: !remainingIds.includes(deviceId) };
}

async function readInventoryForCleanupReconciliation(pairing, deviceEvidence) {
  try {
    return await readDeviceInventory(pairing, deviceEvidence);
  } catch (error) {
    if (!isRetryableInventoryReadFailure(error)) throw error;
    recordCleanupFailure(deviceEvidence, 'device-inventory-first-read', error);
    return await readDeviceInventory(pairing, deviceEvidence);
  }
}

function isRetryableInventoryReadFailure(error) {
  if (error && (error.httpStatus === 401 || error.httpStatus === 403)) return false;
  if (Number.isInteger(error?.httpStatus)) return true;
  return error instanceof Error && [
    'strict_https_timeout', 'strict_https_request_failed', 'strict_https_response_failed',
  ].includes(error.message);
}

function recordInventoryHttpStatus(deviceEvidence, status) {
  if (deviceEvidence && Array.isArray(deviceEvidence.inventoryHttpStatuses) &&
      deviceEvidence.inventoryHttpStatuses.length < 8) {
    deviceEvidence.inventoryHttpStatuses.push(Number.isInteger(status) ? status : null);
  }
}

function buildMobileWebPairingUrl(mobileWebAddress, gatewayAddress, token, rawRoutes) {
  const mobileWeb = parseStrictHttpsUrl(mobileWebAddress);
  const gateway = canonicalGatewayConnectionUrl(gatewayAddress);
  if (!gateway || !token) throw new Error('mobile_pairing_link_inputs_invalid');
  const routes = rawRoutes ? parseGatewayConnectionRoutes(rawRoutes) : undefined;
  if (rawRoutes && !routes) throw new Error('mobile_pairing_link_routes_invalid');
  if (routes && !routes.endpoints.some(endpoint => endpoint.url === gateway)) throw new Error('gateway_target_missing_from_route_descriptor');
  const gatewayUrl = new URL(gateway);
  const gatewayRouteId = gatewayUrl.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})$/)?.[1];

  const basePath = mobileWeb.pathname.replace(/\/+$/, '');
  mobileWeb.pathname = `${basePath}/connect`;
  mobileWeb.searchParams.set('gateway', gateway);
  if (gatewayRouteId) mobileWeb.searchParams.set('gatewayId', gatewayRouteId);
  if (routes) mobileWeb.searchParams.set('routes', JSON.stringify(routes));
  mobileWeb.hash = new URLSearchParams({ token }).toString();
  if (mobileWeb.toString().length > 8192) throw new Error('mobile_pairing_link_too_long');
  return mobileWeb.toString();
}

function mobileIndexUrl(mobileWebBaseUrl) {
  const url = parseStrictHttpsUrl(mobileWebBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseStrictHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_https_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('strict_https_url_required');
  return url;
}

function logicalMobilePathname(pathname, mobileWebBaseUrl) {
  const prefix = new URL(mobileWebBaseUrl).pathname.replace(/\/+$/, '');
  if (!prefix || prefix === '/') return pathname;
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
  throw new Error('mobile_mount_prefix_mismatch');
}

function isHomeRoute(pathname, mobileWebBaseUrl) {
  return /^\/h\/[^/]+\/?$/.test(logicalMobilePathname(pathname, mobileWebBaseUrl));
}

function profileIdFromHomePath(pathname, mobileWebBaseUrl) {
  return logicalMobilePathname(pathname, mobileWebBaseUrl).match(/^\/h\/([^/]+)\/?$/)?.[1] ?? null;
}

function assertSafeHomeRoute(pathname, mobileWebBaseUrl) {
  if (!isHomeRoute(pathname, mobileWebBaseUrl)) throw new Error('mobile_home_route_missing');
}

function recordSafeMobileLocation(target, pageUrl, lane) {
  const location = safeMobileLocation(pageUrl, lane);
  target.pathShape = location.pathShape;
  target.originMatchesExpected = location.originMatchesExpected;
  target.withinExpectedBase = location.withinExpectedBase;
  target.baseMatchesExpectedGateway = location.baseMatchesExpectedGateway;
}

function safeMobileLocation(pageUrl, lane) {
  let current;
  let mobileBase;
  try {
    current = new URL(pageUrl);
    mobileBase = new URL(lane.mobileWebBaseUrl);
  } catch {
    return {
      pathShape: '/<invalid>', originMatchesExpected: false,
      withinExpectedBase: false, baseMatchesExpectedGateway: false,
    };
  }
  const basePath = normalizePathname(mobileBase.pathname);
  const currentPath = current.pathname;
  const withinExpectedBase = currentPath === basePath || currentPath.startsWith(`${basePath}/`);
  let baseMatchesExpectedGateway = false;
  try {
    const gatewayText = canonicalGatewayConnectionUrl(lane.gatewayAddress);
    if (gatewayText) {
      const gateway = new URL(gatewayText);
      const gatewayPath = normalizePathname(gateway.pathname);
      const expectedMobilePath = `${gatewayPath === '/' ? '' : gatewayPath}/mobile` || '/mobile';
      baseMatchesExpectedGateway = gateway.origin === mobileBase.origin && basePath === expectedMobilePath;
    }
  } catch {}
  return {
    pathShape: safeMobilePathShape(currentPath, basePath),
    originMatchesExpected: current.origin === mobileBase.origin,
    withinExpectedBase,
    baseMatchesExpectedGateway,
  };
}

function normalizePathname(pathname) {
  const value = pathname.replace(/\/+$/, '');
  return value || '/';
}

function safeMobilePathShape(pathname, basePath) {
  const baseShape = /^\/g\/[A-Za-z0-9_-]{1,64}\/mobile$/.test(basePath)
    ? '/g/<route>/mobile'
    : basePath === '/mobile' ? '/mobile' : '/<mount>';
  if (pathname === basePath) return `${baseShape}/`;
  if (pathname.startsWith(`${basePath}/`)) {
    return `${baseShape}${safeMobileRouteSuffix(pathname.slice(basePath.length))}`;
  }
  const mounted = pathname.match(/^\/g\/[A-Za-z0-9_-]{1,64}\/mobile(?=\/|$)(.*)$/);
  if (mounted) return `/g/<route>/mobile${safeMobileRouteSuffix(mounted[1])}`;
  const direct = pathname.match(/^\/mobile(?=\/|$)(.*)$/);
  if (direct) return `/mobile${safeMobileRouteSuffix(direct[1])}`;
  return safeMobileRouteSuffix(pathname);
}

function safeMobileRouteSuffix(suffix) {
  if (!suffix || suffix === '/') return '/';
  if (/^\/connect\/?$/.test(suffix)) return '/connect';
  if (/^\/h\/[^/]+\/?$/.test(suffix)) return '/h/<profile>';
  if (/^\/h\/[^/]+\/task\/[^/]+\/[^/]+\/?$/.test(suffix)) {
    return '/h/<profile>/task/<server>/<thread>';
  }
  if (/^\/h\/[^/]+(?:\/|$)/.test(suffix)) return '/h/<profile>/<nested>';
  return '/<other>';
}

function safeDiagnosticErrorName(error) {
  const name = error instanceof Error ? error.name : '';
  return SAFE_DIAGNOSTIC_ERROR_NAMES.has(name) ? name : 'UnknownError';
}

function safeDiagnosticErrorMessage(error) {
  const message = error instanceof Error ? error.message : '';
  return SAFE_DIAGNOSTIC_ERROR_MESSAGES.has(message) ? message : 'unclassified_error';
}

function recordSafeFailure(target, stage, error) {
  if (target.failureStage) return false;
  target.failureStage = stage;
  target.failureErrorName = safeDiagnosticErrorName(error);
  target.failureMessage = safeDiagnosticErrorMessage(error);
  return true;
}

function recordCleanupFailure(deviceEvidence, stage, error) {
  if (!deviceEvidence || !Array.isArray(deviceEvidence.cleanupFailures) || deviceEvidence.cleanupFailures.length >= 4) return;
  deviceEvidence.cleanupFailures.push({
    stage,
    errorName: safeDiagnosticErrorName(error),
    errorMessage: safeDiagnosticErrorMessage(error),
  });
}

function safeFailureClass(error) {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (message === 'ERR_NETWORK_CHANGED' || /ERR_NETWORK_CHANGED/.test(message)) return 'ERR_NETWORK_CHANGED';
  if (/token_fragment_scrub_failed/.test(message)) return 'token_fragment_scrub_failed';
  if (/session_rejected/.test(message)) return 'mobile_pairing_session_rejected';
  if (/version_mismatch/.test(message)) return 'app_server_version_mismatch';
  if (/cleanup|device/.test(message)) return 'device_cleanup_or_inventory_failed';
  if (name === 'AssertionError') return 'assertion_failed';
  if (/Timeout|timeout/.test(name + message)) return 'timeout';
  if (SAFE_DIAGNOSTIC_ERROR_MESSAGES.has(message)) return message;
  return 'acceptance_step_failed';
}

async function verifyReleasePins(release) {
  for (const path of [release.sourceRoot, release.updaterReceiptPath, release.mobileWebManifestPath, release.rustCliBinaryPath]) {
    if (resolve(path) !== path) throw new Error('release_path_not_canonical');
    assertOutsideRepository(path, 'release evidence path');
  }
  const manifest = await sha256RegularFile(release.mobileWebManifestPath, 'mobile web manifest');
  const cli = await sha256RegularFile(release.rustCliBinaryPath, 'Rust CLI binary');
  if (manifest.sha256 !== release.mobileWebManifestSha256 || cli.sha256 !== release.rustCliSha256) {
    throw new Error('release_source_pin_mismatch');
  }
  const sourceRoot = resolve(release.sourceRoot);
  assertOutsideRepository(sourceRoot, 'release source root');
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || (typeof process.getuid === 'function' && sourceInfo.uid !== process.getuid()) ||
      await realpath(sourceRoot) !== sourceRoot) throw new Error('release_source_root_invalid');
  const git = args => execFileSync('git', ['-C', sourceRoot, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024,
  }).trim();
  const gitHead = git(['rev-parse', 'HEAD']);
  const gitTree = git(['rev-parse', 'HEAD^{tree}']);
  if (gitHead !== release.sourceCommit || git(['status', '--porcelain', '--untracked-files=normal']) !== '') {
    throw new Error('release_git_source_mismatch');
  }
  const receipt = await readVerifiedUpdaterReceipt(release);
  if (receipt.sourceCommit !== release.sourceCommit || receipt.sourceTree !== gitTree ||
      receipt.binarySha256 !== cli.sha256 || receipt.mobileManifestSha256 !== manifest.sha256 ||
      receipt.health?.authenticated !== true || !Number.isSafeInteger(receipt.health?.serverCount) || receipt.health.serverCount < 1 ||
      !Array.isArray(receipt.health?.mobileResources) || receipt.health.mobileResources.length < 1) {
    throw new Error('updater_receipt_source_mismatch');
  }
  return {
    sourceCommit: gitHead,
    sourceTree: gitTree,
    version: release.version,
    mobileWebManifestSha256: manifest.sha256,
    rustCliBinarySha256: cli.sha256,
    updaterStatus: receipt.status,
    updaterReceiptSha256: release.updaterReceiptSha256,
    updaterHealth: {
      authenticated: true,
      serverCount: receipt.health.serverCount,
      mobileResourceCount: receipt.health.mobileResources.length,
    },
  };
}

async function readVerifiedUpdaterReceipt(release) {
  const receiptPath = resolve(release.updaterReceiptPath);
  const sourceRelativePath = relative(resolve(release.sourceRoot), receiptPath);
  if (sourceRelativePath === '' || sourceRelativePath === '..' || sourceRelativePath.startsWith(`..${sep}`) || isAbsolute(sourceRelativePath)) {
    throw new Error('updater_receipt_outside_release_source');
  }
  const info = await lstat(receiptPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES ||
      (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      await realpath(receiptPath) !== receiptPath) throw new Error('updater_receipt_file_invalid');
  const bytes = await readFile(receiptPath);
  if (createHash('sha256').update(bytes).digest('hex') !== release.updaterReceiptSha256) throw new Error('updater_receipt_hash_mismatch');
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('updater_receipt_invalid_json'); }
  if (!receipt || receipt.status !== 'committed' || receipt.version !== 1 ||
      !Array.isArray(receipt.units) || receipt.units.length !== 2 ||
      receipt.units[0] !== 'kcoder-cyx-relay-gateway.service' ||
      receipt.units[1] !== 'kcoder-cyx-relay-client.service') {
    throw new Error('updater_receipt_not_committed');
  }
  return receipt;
}

async function sha256RegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      await realpath(path) !== path) {
    throw new Error(`${label} is not a singly-linked owned regular file`);
  }
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readAndVerifyLanCa() {
  const info = await lstat(LAN_CA_PATH);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('staged_lan_ca_not_regular');
  const pem = await readFile(LAN_CA_PATH, 'utf8');
  const sha256 = createHash('sha256').update(pem).digest('hex');
  if (sha256 !== LAN_CA_SHA256) throw new Error('staged_lan_ca_hash_mismatch');
  return pem;
}

async function strictHttpsRequest(url, { method = 'GET', headers = {}, body, caPem } = {}) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'https:') throw new Error('strict_https_request_required');
  const { request } = await import('node:https');
  return new Promise((resolveResponse, rejectResponse) => {
    const requestObject = request(target, {
      method,
      headers,
      ...(caPem ? { ca: caPem } : {}),
      rejectUnauthorized: true,
      timeout: 15_000,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          requestObject.destroy(new Error('bounded_response_exceeded'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', () => rejectResponse(new Error('strict_https_response_failed')));
    });
    requestObject.on('timeout', () => requestObject.destroy(new Error('strict_https_timeout')));
    requestObject.on('error', () => rejectResponse(new Error('strict_https_request_failed')));
    if (body !== undefined) requestObject.write(body);
    requestObject.end();
  });
}

async function readPrivateConfig(path) {
  const absolutePath = resolve(path);
  assertOutsideRepository(absolutePath, 'acceptance config');
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES || (info.mode & 0o077) !== 0 ||
      await realpath(absolutePath) !== absolutePath ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('acceptance config must be an owned, private, singly-linked regular file outside the repository');
  }
  let config;
  try { config = JSON.parse(await readFile(absolutePath, 'utf8')); } catch { throw new Error('acceptance config is not valid JSON'); }
  return config;
}

function validateConfig(config, configPath) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1 ||
      !config.release || !config.lanes || !config.lanes.public || !config.lanes.lan ||
      typeof config.chromiumExecutablePath !== 'string' || !isAbsolute(config.chromiumExecutablePath) ||
      typeof config.deliveryFile !== 'string' || !isAbsolute(config.deliveryFile)) {
    throw new Error('acceptance config schema is invalid');
  }
  assertOutsideRepository(configPath, 'acceptance config');
  assertOutsideRepository(config.deliveryFile, 'delivery file');
  if (config.deliveryFile === resolve(configPath)) throw new Error('delivery file must be separate from the acceptance config');
  const release = config.release;
  if (release.version !== EXPECTED_VERSION || typeof release.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(release.sourceCommit) ||
      typeof release.sourceRoot !== 'string' || !isAbsolute(release.sourceRoot) || resolve(release.sourceRoot) !== release.sourceRoot ||
      typeof release.updaterReceiptPath !== 'string' || !isAbsolute(release.updaterReceiptPath) || resolve(release.updaterReceiptPath) !== release.updaterReceiptPath ||
      typeof release.updaterReceiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.updaterReceiptSha256) ||
      typeof release.mobileWebManifestPath !== 'string' || !isAbsolute(release.mobileWebManifestPath) || resolve(release.mobileWebManifestPath) !== release.mobileWebManifestPath ||
      typeof release.mobileWebManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.mobileWebManifestSha256) ||
      typeof release.rustCliBinaryPath !== 'string' || !isAbsolute(release.rustCliBinaryPath) || resolve(release.rustCliBinaryPath) !== release.rustCliBinaryPath ||
      typeof release.rustCliSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.rustCliSha256)) {
    throw new Error('acceptance release pins are invalid');
  }
  for (const laneName of ['public', 'lan']) {
    const lane = config.lanes[laneName];
    if (!lane || typeof lane.mobileWebBaseUrl !== 'string' || typeof lane.gatewayAdminBaseUrl !== 'string' ||
        typeof lane.gatewayAddress !== 'string' || typeof lane.adminToken !== 'string' ||
        !/^[A-Za-z0-9._~-]{32,512}$/.test(lane.adminToken)) throw new Error(`${laneName} lane config is invalid`);
    const mobileWebUrl = parseStrictHttpsUrl(lane.mobileWebBaseUrl);
    const adminUrl = parseStrictHttpsUrl(lane.gatewayAdminBaseUrl);
    parseStrictHttpsUrl(lane.gatewayAddress);
    if (!canonicalGatewayConnectionUrl(lane.gatewayAddress)) throw new Error(`${laneName} Gateway address is invalid`);
    if (adminUrl.hostname !== LAN_CADDY_HOST) {
      throw new Error(`Gateway admin endpoint must use the verified direct Gateway LAN host ${LAN_CADDY_HOST}`);
    }
    if (laneName === 'lan' && mobileWebUrl.hostname !== LAN_CADDY_HOST) {
      throw new Error(`LAN Mobile Web origin must use the certificate IP SAN ${LAN_CADDY_HOST}`);
    }
  }
}

function assertOutsideRepository(path, label) {
  const rel = relative(repoRoot, resolve(path));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error(`${label} must be outside the repository`);
  }
}

async function writeProtectedDeliveryFile(path, value) {
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  assertOutsideRepository(absolutePath, 'delivery file');
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) {
    throw new Error('delivery parent must be an owned private directory');
  }
  const handle = await open(absolutePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  const identity = await handle.stat();
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o077) !== 0) throw new Error('delivery file permissions are unsafe');
  } catch (error) {
    await handle.close().catch(() => undefined);
    const current = await lstat(absolutePath).catch(() => null);
    if (current && current.dev === identity.dev && current.ino === identity.ino && current.isFile() && !current.isSymbolicLink()) {
      const { unlink } = await import('node:fs/promises');
      await unlink(absolutePath).catch(() => undefined);
    }
    throw error;
  }
  await handle.close();
  const final = await lstat(absolutePath);
  if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1 || (final.mode & 0o077) !== 0) {
    throw new Error('delivery file post-write verification failed');
  }
}

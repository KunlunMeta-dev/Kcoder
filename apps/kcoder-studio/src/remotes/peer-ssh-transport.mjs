import { randomBytes } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { realpathSync, statSync, readlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AgentMessageRouterError, routerIdentity, requireRouter } from '../agent-message-router-private.js';
import { peerSshEnrollmentSelector, assertPeerSshEnrollmentCurrent, revalidatePeerSshEnrollment,
  authenticateEnrolledPeerSsh, verifyEnrolledPeerSshIdentity } from './peer-ssh-auth.mjs';

export const PEER_SSH_OFFER = 'peerSshParentOfferV1';
export const PEER_SSH_BIND = 'agentMessage/router/sshParentBind';
export const PEER_SSH_PURPOSE = 'kcoder.peer-message.ssh-parent.v1';
const launches = new WeakMap();
const transports = new WeakSet();
const authenticatedFacts = new WeakSet();
const nonce = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = reason => new AgentMessageRouterError(reason);
export const peerSshAuthenticationSupported = () => process.platform === 'linux';
const fileIdentity = path => {
  const value = statSync(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
};

/** The factory calls this only after an actual probe authenticated and exited.
 * This object is never deserialized or passed to public/model request handling.
 */
export function capturePeerSshLaunch({ target, fingerprint, verifyCurrent }) {
  requireRouter(target?.transport === 'ssh' && !target.security && target.remotePlatform !== 'windows' &&
    authenticatedFacts.has(fingerprint) && typeof verifyCurrent === 'function', 'AGENT_MESSAGES_SSH_LAUNCH_UNAVAILABLE');
  verifyCurrent(); fingerprint.verifyPolicy(); fingerprint.requireExited();
  const launch = Object.freeze({});
  launches.set(launch, { nonce: randomBytes(32).toString('hex'), targetId: target.id,
    fingerprint, verifyCurrent });
  return launch;
}
export function captureEnrolledPeerSshLaunch({ target, selection, verifyCurrent }) {
  requireRouter(target?.transport === 'ssh' && !target.security && target.remotePlatform !== 'windows' &&
    typeof verifyCurrent === 'function', 'AGENT_MESSAGES_SSH_LAUNCH_UNAVAILABLE');
  verifyCurrent();
  const selector = peerSshEnrollmentSelector(selection);
  const launch = Object.freeze({});
  launches.set(launch, { selection, selector, targetId: target.id, verifyCurrent });
  return launch;
}
export function peerSshLaunchArguments(launch, target) {
  const captured = launches.get(launch);
  requireRouter(captured && captured.targetId === target?.id && target.transport === 'ssh' && !target.security,
    'AGENT_MESSAGES_SSH_LAUNCH_UNAVAILABLE');
  captured.verifyCurrent();
  if (captured.selection) {
    assertPeerSshEnrollmentCurrent(captured.selection);
    return ['--peer-router-parent-ssh-v2', captured.selector];
  }
  captured.fingerprint.verifyPolicy();
  return ['--peer-router-parent-ssh-v1', captured.nonce];
}
export function peerSshDiagnosticSpec(spec) {
  requireRouter(spec?.command === 'ssh' && Array.isArray(spec.args), 'AGENT_MESSAGES_SSH_TRANSPORT_UNAVAILABLE');
  // Reusing an unrelated ControlMaster cannot establish this process's own
  // authentication/host-key facts or make its lifetime our resource lease.
  return { ...spec, args: ['-o', 'LogLevel=DEBUG1', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...spec.args] };
}

/** Observe OpenSSH's actual authenticated transport, never JSON-reported facts.
 * Only file metadata is rechecked after loading; no key/executable/tree hashing
 * occurs on the ordinary route or reverse-request path.
 */
export function observePeerSshAuthentication({ child, target, isTrackedChild, verifyCurrent,
  timeoutMs = 15_000, sshImage = '/usr/bin/ssh' }) {
  requireRouter(child instanceof ChildProcess && child.spawnfile === 'ssh' && child.stdin && child.stdout && child.stderr &&
    target?.transport === 'ssh' && !target.security && typeof isTrackedChild === 'function' &&
    typeof verifyCurrent === 'function', 'AGENT_MESSAGES_SSH_TRANSPORT_UNAVAILABLE');
  const image = realpathSync(sshImage);
  const imageIdentity = statSync(image, { bigint: true });
  let line = '', key, username, authenticated = false, closed = false, processClosed = false, settled = false, timer;
  const files = new Map();
  const verifyPolicy = () => {
    verifyCurrent();
    for (const [path, identity] of files) requireRouter(fileIdentity(path) === identity, 'AGENT_MESSAGES_SSH_POLICY_CHANGED');
  };
  const verify = () => {
    verifyPolicy();
    requireRouter(!closed && isTrackedChild(child) && child.exitCode === null && child.signalCode === null &&
      !child.stdin.destroyed && !child.stdout.destroyed, 'AGENT_MESSAGES_SSH_TRANSPORT_CLOSED');
    if (process.platform === 'linux') {
      const actual = statSync(`/proc/${child.pid}/exe`, { bigint: true });
      requireRouter(actual.dev === imageIdentity.dev && actual.ino === imageIdentity.ino &&
        realpathSync(readlinkSync(`/proc/${child.pid}/exe`)) === image, 'AGENT_MESSAGES_SSH_IMAGE_CHANGED');
    }
  };
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The owner may inspect failure after initialization; avoid an unhandled early
  // rejection while Native is still starting on the same held transport.
  ready.catch(() => {});
  const finish = error => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    child.stderr.off('data', receive);
    if (error) rejectReady(error);
    else {
      const facts = Object.freeze({ authenticated: true, key, username,
        fingerprint: JSON.stringify([key, username, target.host, target.port ?? 22]), verify, verifyPolicy,
        requireExited() { requireRouter(processClosed && (child.exitCode !== null || child.signalCode !== null),
          'AGENT_MESSAGES_SSH_PROBE_EXIT_UNCONFIRMED'); } });
      authenticatedFacts.add(facts); resolveReady(facts);
    }
  };
  const remember = path => {
    requireRouter(files.size < 32 || files.has(path), 'AGENT_MESSAGES_SSH_POLICY_CAPACITY');
    const identity = fileIdentity(path);
    requireRouter(!files.has(path) || files.get(path) === identity, 'AGENT_MESSAGES_SSH_POLICY_CHANGED');
    files.set(path, identity);
  };
  const inspect = value => {
    let match;
    if ((match = /^debug1: Reading configuration data (.+)$/.exec(value))) remember(match[1]);
    if ((match = /^debug1: Found key in (.+):[0-9]+$/.exec(value))) remember(match[1]);
    if ((match = /^debug1: Server host key: ([a-zA-Z0-9@._+-]+ SHA256:[a-zA-Z0-9+/]+)$/.exec(value))) {
      requireRouter(!key || key === match[1], 'AGENT_MESSAGES_SSH_HOST_KEY_CHANGED'); key = match[1];
    }
    if ((match = /^debug1: Authenticating to .+ as '([^'\r\n]+)'$/.exec(value))) {
      requireRouter(!username || username === match[1], 'AGENT_MESSAGES_SSH_ACCOUNT_CHANGED'); username = match[1];
    }
    if (/^Authenticated to .+ using "(?:publickey|hostbased|gssapi-with-mic)"\.$/.test(value)) {
      requireRouter(key && username && (!target.user || target.user === username), 'AGENT_MESSAGES_SSH_AUTHENTICATION_UNCONFIRMED');
      authenticated = true; verify(); finish();
    }
  };
  const receive = chunk => {
    try {
      line += chunk.toString('utf8');
      requireRouter(line.length <= 65536, 'AGENT_MESSAGES_SSH_DIAGNOSTICS_LIMIT');
      let index;
      while (!settled && (index = line.indexOf('\n')) >= 0) { const value = line.slice(0, index).replace(/\r$/, ''); line = line.slice(index + 1); inspect(value); }
    } catch (error) { finish(error); closed = true; }
  };
  child.stderr.on('data', receive);
  child.once('close', () => { closed = true; processClosed = true; child.stderr.off('data', receive); finish(failure('AGENT_MESSAGES_SSH_TRANSPORT_CLOSED')); });
  child.once('error', () => { closed = true; finish(failure('AGENT_MESSAGES_SSH_TRANSPORT_UNAVAILABLE')); });
  timer = setTimeout(() => finish(failure('AGENT_MESSAGES_SSH_AUTHENTICATION_UNCONFIRMED')), timeoutMs); timer.unref?.();
  return Object.freeze({ ready, verify, get authenticated() { return authenticated; },
    close() { closed = true; child.stderr.off('data', receive); finish(failure('AGENT_MESSAGES_SSH_TRANSPORT_CLOSED')); } });
}

export function capturePeerSshTransport({ launch, child, authentication, getBroker }) {
  const captured = launches.get(launch);
  requireRouter(captured && child instanceof ChildProcess && authentication && typeof getBroker === 'function',
    'AGENT_MESSAGES_SSH_LAUNCH_UNAVAILABLE');
  let binding, authenticated, enrolled, closed = false;
  const assertCurrent = ({ child: observed = child, serverId = captured.targetId } = {}) => {
    captured.verifyCurrent();
    requireRouter(!closed && observed === child && serverId === captured.targetId &&
      getBroker()?.child === child && !getBroker().closed, 'AGENT_MESSAGES_SSH_TRANSPORT_CHANGED');
    authentication.verify();
    if (captured.selection) assertPeerSshEnrollmentCurrent(captured.selection);
    else captured.fingerprint.verifyPolicy();
    if (binding) {
      requireRouter(getBroker().peerSshTransport === transport && nonce(binding.processInstance), 'AGENT_MESSAGES_SSH_ENDPOINT_CHANGED');
    }
  };
  const transport = Object.freeze({
    assertCurrent,
    get ready() { try { assertCurrent(); return Boolean(binding); } catch { return false; } },
    async authenticate() {
      requireRouter(captured.selection && !enrolled && !binding, 'AGENT_MESSAGES_SSH_AUTH_PHASE_INVALID');
      enrolled = await authenticateEnrolledPeerSsh({ selection: captured.selection, broker: getBroker(), authentication, assertTransport: assertCurrent });
      assertCurrent();
    },
    async revalidate() {
      assertCurrent();
      if (captured.selection) await revalidatePeerSshEnrollment(captured.selection);
      assertCurrent();
    },
    async complete() {
      assertCurrent(); authenticated = await authentication.ready; assertCurrent();
      if (!captured.selection) requireRouter(authenticated.fingerprint === captured.fingerprint.fingerprint, 'AGENT_MESSAGES_SSH_HOST_KEY_CHANGED');
      requireRouter(getBroker().initializeResponse?.result?.capabilities?.experimental?.agentMessageRouterPrivateV1 === true,
        'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
      if (captured.selection) {
        requireRouter(enrolled, 'AGENT_MESSAGES_SSH_AUTH_PHASE_INVALID');
        const response = await new Promise(resolve => getBroker().sendInternalRequest('agentMessage/router/identity', {}, { onResponse: resolve }));
        await transport.revalidate();
        requireRouter(!response?.error, 'AGENT_MESSAGES_SSH_BINDING_UNCONFIRMED');
        const identity = verifyEnrolledPeerSshIdentity(enrolled, response.result);
        binding = Object.freeze({ identity, processInstance: enrolled.processInstance, accountUid: enrolled.enrollment.native.accountUid });
        assertCurrent(); return transport;
      }
      const response = await new Promise(resolve => getBroker().sendInternalRequest(PEER_SSH_BIND,
        { version: 1, purpose: PEER_SSH_PURPOSE, nonce: captured.nonce }, { onResponse: resolve }));
      assertCurrent();
      const value = response?.result;
      requireRouter(!response?.error && value && Object.keys(value).sort().join(',') ===
        ['version', 'purpose', 'nonce', 'processInstance', 'accountUid', 'identity'].sort().join(',') &&
        value.version === 1 && value.purpose === PEER_SSH_PURPOSE && value.nonce === captured.nonce &&
        nonce(value.processInstance) && Number.isInteger(value.accountUid) && value.accountUid >= 0,
        'AGENT_MESSAGES_SSH_BINDING_UNCONFIRMED');
      const identity = routerIdentity(value.identity);
      // The actual authenticated process returns its canonical identity in the
      // fresh nonce response. Later private identity reads compare this exact
      // binding again; a catalog label never creates an endpoint identity.
      binding = Object.freeze({ ...value, identity });
      assertCurrent();
      return transport;
    },
    verifyIdentity(identity) { assertCurrent(); requireRouter(binding && isDeepStrictEqual(binding.identity, identity), 'AGENT_MESSAGES_SSH_ENDPOINT_CHANGED'); },
    close() { closed = true; authentication.close(); },
  });
  transports.add(transport);
  child.once('close', () => transport.close());
  return transport;
}
export function isCapturedPeerSshTransport(value, child) {
  if (!transports.has(value)) return false;
  try { value.assertCurrent({ child }); return value.ready; } catch { return false; }
}

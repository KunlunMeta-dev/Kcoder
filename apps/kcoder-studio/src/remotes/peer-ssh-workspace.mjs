import { spawn } from 'node:child_process';
import { WorkspaceAppServerBroker } from '../workspace-app-server-broker.js';
import { createRuntimeTargetAdapter } from '../runtime-target-adapter.js';
import { initializeAgentMessageEndpoint } from '../agent-message-router-gateway.js';
import { launchSpec, appServerEnvironment } from '../server-config.js';
import { createAgentMessageRouterBackchannel } from '../agent-message-router-backchannel.js';
import { requireRouter } from '../agent-message-router-private.js';
import { createPeerSshEnrollmentGateway } from './peer-ssh-enrollment-gateway.mjs';
import { PEER_SSH_OFFER, capturePeerSshLaunch, captureEnrolledPeerSshLaunch, peerSshDiagnosticSpec, peerSshAuthenticationSupported,
  observePeerSshAuthentication, capturePeerSshTransport } from './peer-ssh-transport.mjs';

/** Negotiation happens only before admitting a new ordinary workspace broker.
 * Existing brokers and their live sessions are never replaced by a probe.
 */
export function createPeerSshWorkspaceFactory({ getTarget, targetSignature, loginContexts,
  trackChild, isTrackedChild, terminateChild, createWorkspaceBroker, getRouter,
  scenario = '', baseEnv = process.env, maxMessageBytes = 2 * 1024 * 1024, enrollment }) {
  const pending = new Map();
  const openingChildren = new Set(); let closed = false;
  const enrollmentOwner = enrollment ? createPeerSshEnrollmentGateway({ ...enrollment, getTarget, targetSignature,
    loginContexts, trackChild, isTrackedChild, terminateChild, baseEnv }) : null;
  async function open(target, workspacePath, key, options) {
    const signature = targetSignature(target);
    // Plain SSH owns an OS account transport shared by authenticated clients.
    // Browser/device authority is purpose-bound and rechecked by the router;
    // one browser logout must not become another client's SSH account change.
    const accountOwner = undefined;
    const generation = loginContexts.generation(accountOwner, target.id);
    const principal = loginContexts.identity(accountOwner, target.id);
    const verifyScope = () => {
      const current = getTarget(target.id);
      requireRouter(!closed && current && targetSignature(current) === signature &&
        loginContexts.generation(accountOwner, target.id) === generation &&
        loginContexts.identity(accountOwner, target.id) === principal, 'AGENT_MESSAGES_SSH_SCOPE_CHANGED');
    };
    const verifyCurrent = () => { verifyScope(); requireRouter(!options.isCancelled?.(), 'AGENT_MESSAGES_SSH_SCOPE_CHANGED'); };
    verifyCurrent();
    const pinned = await enrollmentOwner?.resolve(target, workspacePath, verifyScope);
    verifyCurrent();
    if (pinned?.configured) {
      if (!pinned.selection) return createWorkspaceBroker(target, workspacePath, key, options);
      const peerSshLaunch = captureEnrolledPeerSshLaunch({ target, selection: pinned.selection, verifyCurrent: verifyScope });
      const broker = createWorkspaceBroker(target, workspacePath, key, { ...options, peerSshLaunch });
      openingChildren.add(broker.child);
      try {
        await broker.peerSshTransport.authenticate(); verifyCurrent();
        await initializeAgentMessageEndpoint(broker); verifyCurrent();
        await broker.peerSshTransport.complete(); verifyCurrent();
        broker.peerSshInitializing = false; openingChildren.delete(broker.child); return broker;
      } catch {
        broker.peerSshTransport?.close(); await terminateChild(broker.child); openingChildren.delete(broker.child);
        verifyCurrent();
        // A failed/revoked pin never falls back to another private purpose.
        return createWorkspaceBroker(target, workspacePath, key, options);
      }
    }
    const spec = peerSshDiagnosticSpec(launchSpec(target, { workspacePath, scenario }));
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd,
      env: appServerEnvironment(baseEnv, spec.env), stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Adoption is synchronous and precedes all external waits.
    child.once('error', () => {});
    trackChild(child, target.id);
    openingChildren.add(child);
    const authentication = observePeerSshAuthentication({ child, target, isTrackedChild, verifyCurrent: verifyScope });
    const probe = new WorkspaceAppServerBroker({ child, adapter: createRuntimeTargetAdapter('kcoder'),
      maxMessageBytes, serverId: target.id, targetTransport: 'ssh' });
    let supported, fingerprint;
    try {
      verifyCurrent(); await initializeAgentMessageEndpoint(probe); verifyCurrent();
      supported = probe.initializeResponse?.result?.capabilities?.experimental?.[PEER_SSH_OFFER] === true;
      fingerprint = await authentication.ready; verifyCurrent();
    } finally {
      await terminateChild(child);
      openingChildren.delete(child);
      authentication.close();
    }
    // An unobserved exit cannot authorize launching a second private owner.
    requireRouter(!isTrackedChild(child) && (child.exitCode !== null || child.signalCode !== null),
      'AGENT_MESSAGES_SSH_PROBE_EXIT_UNCONFIRMED');
    verifyCurrent();
    if (!supported) return createWorkspaceBroker(target, workspacePath, key, options);
    const peerSshLaunch = capturePeerSshLaunch({ target, fingerprint, verifyCurrent: verifyScope });
    const broker = createWorkspaceBroker(target, workspacePath, key, { ...options, peerSshLaunch });
    openingChildren.add(broker.child);
    try {
      verifyCurrent(); await initializeAgentMessageEndpoint(broker); verifyCurrent();
      await broker.peerSshTransport.complete(); verifyCurrent();
      broker.peerSshInitializing = false;
      openingChildren.delete(broker.child);
      return broker;
    } catch (error) {
      broker.peerSshTransport?.close();
      await terminateChild(broker.child);
      openingChildren.delete(broker.child);
      throw error;
    }
  }
  return Object.freeze({
    handleEnrollmentRequest: (...args) => enrollmentOwner?.handle(...args) ?? false,
    async close() {
      closed = true;
      const enrollmentClosing = enrollmentOwner?.close();
      await Promise.allSettled([...openingChildren].map(child => terminateChild(child)));
      await Promise.allSettled([...pending.values()]);
      await enrollmentClosing;
    },
    wait(key) { return pending.get(key); },
    create(target, workspacePath, key, options = {}) {
      if (closed) return Promise.reject(new Error('PEER_SSH_WORKSPACE_OWNER_CLOSED'));
      const configured = getTarget(target.id);
      if (!peerSshAuthenticationSupported() || target.transport !== 'ssh' || target.security || target.remotePlatform === 'windows' || options.nativeManagementOnly ||
          !configured || targetSignature(configured) !== targetSignature(target))
        return Promise.resolve(createWorkspaceBroker(target, workspacePath, key, options));
      let creating = pending.get(key);
      if (!creating) {
        creating = open(target, workspacePath, key, options).finally(() => {
          if (pending.get(key) === creating) pending.delete(key);
        });
        pending.set(key, creating);
      }
      return creating;
    },
    capture({ launch, target, child, getBroker }) {
      const authentication = observePeerSshAuthentication({ child, target, isTrackedChild,
        verifyCurrent: () => {
          const broker = getBroker();
          requireRouter(!broker || broker.agentMessageTargetSignature === targetSignature(getTarget(target.id)),
            'AGENT_MESSAGES_SSH_SCOPE_CHANGED');
        } });
      const transport = capturePeerSshTransport({ launch, child, authentication, getBroker });
      const backchannel = createAgentMessageRouterBackchannel({ child, serverId: target.id, getBroker, getRouter,
        assertSourceOwner: context => { transport.assertCurrent(context); requireRouter(transport.ready, 'AGENT_MESSAGES_SSH_BINDING_UNCONFIRMED'); },
        reply: message => getBroker().safeWriteMessage(message) });
      return { transport, backchannel: { receiveBackend: request => backchannel.receiveBackend(request),
        close() { backchannel.close(); transport.close(); } } };
    },
  });
}

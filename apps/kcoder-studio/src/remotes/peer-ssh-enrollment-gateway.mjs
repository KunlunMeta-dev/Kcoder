import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isContract } from '../../shared/generated/validator.mjs';
import { createPeerSshPinStore } from './peer-ssh-pin-store.mjs';
import { createPeerSshAdminRunner } from './peer-ssh-admin.mjs';
import { validateRemoteWorkspace } from './ssh-launch.mjs';
import { orderedPeerSshEnrollment, PEER_SSH_ENROLLMENT_PURPOSE, PEER_SSH_PIN_PURPOSE } from './peer-ssh-facts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 409, unknown = false) => Object.assign(new Error(code), { code, status, ...(unknown ? { externalOutcome: 'unknown' } : {}) });
const keys = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const workspaceFor = (target, selected) => selected ?? target.remoteCwd;
const scopeFor = (target, workspace) => hash(JSON.stringify(['kcoder.peer-ssh.scope.v1', target.id, workspace]));

/** Explicit browser administration is separate from model/public RPC and from
 * the enrolled transport. Proposals contain comparison data, never private keys.
 */
export function createPeerSshEnrollmentGateway({ directory, getTarget, targetSignature, loginContexts,
  authorize, sameOrigin, requestBody, jsonResponse, trackChild, isTrackedChild, terminateChild,
  baseEnv, store = createPeerSshPinStore({ directory }), runner = createPeerSshAdminRunner({ trackChild, isTrackedChild, terminateChild, baseEnv }) }) {
  let closed = false;
  const initialRevokeDispatch = new WeakSet();
  const terminal = proposal => ['completed', 'discarded'].includes(proposal.phase);
  const pending = (data, key) => (data?.proposals ?? []).filter(row => row.scopeKey === key && !terminal(row));
  const scopeAvailable = (data, key, originalId) => {
    if (pending(data, key).some(row => row.id !== originalId)) throw fail('PEER_SSH_SCOPE_PENDING', 409, true);
  };
  const sameBinding = (enrollment, context) => enrollment.target.targetId === context.binding.targetId &&
    enrollment.target.targetRevision === context.binding.targetRevision && enrollment.target.accountGeneration === context.binding.accountGeneration;
  const sameIdentity = (enrollment, observed) => isDeepStrictEqual(enrollment.native, observed.value.native) &&
    enrollment.target.sshHostKey === observed.ssh.sshHostKey && enrollment.target.sshUser === observed.ssh.sshUser;
  const confirmedGeneration = pin => {
    const receipt = pin.receipt;
    if (!isContract('PeerSshPinReceiptV1', receipt) || receipt.enrollmentId !== pin.enrollment.enrollmentId ||
      receipt.status !== pin.status || receipt.generation !== pin.enrollment.generation + (pin.status === 'revoked' ? 1 : 0))
      throw fail('PEER_SSH_PIN_RECEIPT_UNAVAILABLE');
    return receipt.generation;
  };
  function scope(target, workspacePath) {
    const workspace = workspaceFor(target, workspacePath);
    if (target?.transport !== 'ssh' || target.security || target.remotePlatform === 'windows' || typeof workspace !== 'string')
      throw fail('PEER_SSH_ENROLLMENT_TARGET_UNSUPPORTED', 400);
    validateRemoteWorkspace(workspace, target.remotePlatform);
    const signature = targetSignature(target);
    const accountGeneration = hash(JSON.stringify([loginContexts.identity(undefined, target.id), loginContexts.generation(undefined, target.id)]));
    const binding = { targetId: target.id, targetRevision: hash(signature), accountGeneration };
    if (Array.from(accountGeneration).length > 256) throw fail('PEER_SSH_ACCOUNT_SCOPE_UNAVAILABLE');
    const check = () => {
      const current = getTarget(target.id);
      if (closed || !current || targetSignature(current) !== signature ||
        hash(JSON.stringify([loginContexts.identity(undefined, target.id), loginContexts.generation(undefined, target.id)])) !== accountGeneration)
        throw fail('PEER_SSH_ENROLLMENT_SCOPE_CHANGED');
    };
    check();
    return { target, workspace, scopeKey: scopeFor(target, workspace), binding, check };
  }
  const admin = (context, verify, action, extra = {}) => runner.run({ target: context.target, workspacePath: context.workspace,
    verifyCurrent: context.check, authorizeCurrent: verify, action, ...extra });
  const project = proposal => ({ proposalId: proposal.id, digest: proposal.digest, operationId: proposal.operationId,
    phase: proposal.phase, action: proposal.command.action.kind, enrollment: proposal.enrollment,
    ...(proposal.receipt ? { receipt: proposal.receipt } : {}) });

  async function propose(context, verify, revoke) {
    await verify();
    scopeAvailable(await store.read(), context.scopeKey);
    if (runner.supported && !runner.supported()) throw fail('PEER_SSH_ADMIN_HOST_UNSUPPORTED');
    const gateway = await store.initialize(); await verify();
    const existing = (await store.read())?.pins.find(row => row.scopeKey === context.scopeKey);
    await verify();
    if (revoke && !existing) throw fail('PEER_SSH_PIN_NOT_CONFIGURED', 404);
    if (revoke && existing.status !== 'pinned') throw fail('PEER_SSH_PIN_NOT_CURRENT', 409);
    if (existing && !['pinned', 'revoked'].includes(existing.status)) throw fail('PEER_SSH_SCOPE_PENDING', 409, true);
    const priorGeneration = existing ? confirmedGeneration(existing) : 0;
    const observed = await admin(context, verify, revoke || existing?.status === 'pinned' ? 'observe' : 'prepare');
    await verify();
    if (!isContract('PeerSshProfileObservationV1', observed.value)) throw fail('PEER_SSH_PROFILE_OBSERVATION_INVALID');
    const compatible = existing && sameIdentity(existing.enrollment, observed);
    if (existing && !compatible && (revoke || existing.status !== 'revoked')) throw fail('PEER_SSH_PIN_IDENTITY_CHANGED');
    const id = randomUUID(), operationId = randomUUID();
    const enrollment = revoke ? existing.enrollment : orderedPeerSshEnrollment({ version: 1,
      purpose: PEER_SSH_ENROLLMENT_PURPOSE, enrollmentId: compatible ? existing.enrollment.enrollmentId : randomUUID(),
      generation: compatible ? priorGeneration + 1 : 1, gateway,
      target: { ...context.binding, ...observed.ssh }, native: observed.value.native });
    const command = { version: 1, purpose: PEER_SSH_PIN_PURPOSE, operationId, expectedRevision: observed.value.pinRevision,
      action: revoke ? { kind: 'revoke', enrollmentId: enrollment.enrollmentId, expectedGeneration: enrollment.generation } : { kind: 'authorize', enrollment } };
    if (!isContract('PeerSshPinCommandV1', command)) throw fail('PEER_SSH_PIN_COMMAND_INVALID');
    const proposal = { id, operationId, scopeKey: context.scopeKey, workspace: context.workspace, enrollment, command,
      digest: hash(JSON.stringify(command)), phase: 'proposed', createdAt: Date.now() };
    await store.update(data => {
      scopeAvailable(data, context.scopeKey);
      if (!isDeepStrictEqual(data.pins.find(row => row.scopeKey === context.scopeKey), existing)) throw fail('PEER_SSH_PIN_CHANGED');
      if (data.proposals.length >= 128) throw fail('PEER_SSH_PROPOSAL_CAPACITY');
      data.proposals.push(proposal);
    }, verify);
    await verify();
    if (revoke) initialRevokeDispatch.add(proposal);
    return proposal;
  }
  function checkProposalRecord(context, proposal, digest) {
    context.check();
    if (!proposal || proposal.scopeKey !== context.scopeKey || proposal.digest !== digest ||
      proposal.enrollment.target.targetId !== context.binding.targetId || hash(JSON.stringify(proposal.command)) !== proposal.digest)
      throw fail('PEER_SSH_PROPOSAL_CHANGED');
  }
  function checkProposal(context, proposal, digest) {
    checkProposalRecord(context, proposal, digest);
    if (!sameBinding(proposal.enrollment, context)) throw fail('PEER_SSH_PROPOSAL_CHANGED');
  }
  async function finish(context, verify, proposal, receipt) {
    if (!isContract('PeerSshPinReceiptV1', receipt) || receipt.operationId !== proposal.operationId ||
      receipt.enrollmentId !== proposal.enrollment.enrollmentId ||
      receipt.status !== (proposal.command.action.kind === 'revoke' ? 'revoked' : 'pinned') ||
      receipt.generation !== proposal.enrollment.generation + (proposal.command.action.kind === 'revoke' ? 1 : 0))
      throw fail('PEER_SSH_ORIGINAL_RECEIPT_CHANGED');
    await verify();
    await store.update(data => {
      const original = data.proposals.find(row => row.id === proposal.id);
      checkProposal(context, original, proposal.digest);
      if (original.phase === 'completed') return;
      original.phase = 'completed'; original.receipt = receipt;
      const pin = { scopeKey: proposal.scopeKey, status: receipt.status, enrollment: proposal.enrollment, receipt };
      const index = data.pins.findIndex(row => row.scopeKey === proposal.scopeKey);
      if (index < 0) data.pins.push(pin); else data.pins[index] = pin;
    }, verify);
    await verify(); return project({ ...proposal, phase: 'completed', receipt });
  }
  async function execute(context, verify, proposal, reconcileOnly) {
    await verify(); checkProposalRecord(context, proposal, proposal.digest);
    if (proposal.phase === 'discarded') {
      if (reconcileOnly) return project(proposal);
      throw fail('PEER_SSH_PROPOSAL_DISCARDED');
    }
    if (proposal.phase === 'completed') return project(proposal);
    checkProposal(context, proposal, proposal.digest);
    const initialRevoke = initialRevokeDispatch.delete(proposal);
    if (proposal.command.action.kind === 'revoke' && !initialRevoke) reconcileOnly = true;
    if (proposal.phase !== 'proposed' || reconcileOnly) {
      const read = await admin(context, verify, 'receipt', { operationId: proposal.operationId, expectedSsh: proposal.enrollment.target });
      if (!isContract('PeerSshPinReceiptReadV1', read.value) || read.value.operationId !== proposal.operationId)
        throw fail('PEER_SSH_ORIGINAL_RECEIPT_CHANGED');
      if (!read.value.receipt) throw fail('PEER_SSH_SETUP_UNCONFIRMED', 409, true);
      return finish(context, verify, proposal, read.value.receipt);
    }
    // Observe before recording dispatch. Incompatible Native identities or a
    // changed revision are known pre-dispatch failures, not uncertain writes.
    const observed = await admin(context, verify, 'observe', { expectedSsh: proposal.enrollment.target });
    await verify();
    if (!isContract('PeerSshProfileObservationV1', observed.value) || !sameIdentity(proposal.enrollment, observed))
      throw fail('PEER_SSH_PIN_IDENTITY_CHANGED');
    if (observed.value.pinRevision !== proposal.command.expectedRevision) throw fail('PEER_SSH_PIN_NATIVE_REVISION_CHANGED');
    await store.update(data => {
      const original = data.proposals.find(row => row.id === proposal.id);
      checkProposal(context, original, proposal.digest);
      scopeAvailable(data, context.scopeKey, proposal.id);
      if (original.phase === 'discarded') throw fail('PEER_SSH_PROPOSAL_DISCARDED');
      if (original.phase !== 'proposed') throw fail('PEER_SSH_ORIGINAL_RECONCILIATION_REQUIRED');
      original.phase = 'dispatching';
      const old = data.pins.find(row => row.scopeKey === proposal.scopeKey);
      if (old) old.status = proposal.command.action.kind === 'revoke' ? 'revoking' : 'setup_unconfirmed';
    }, verify);
    await verify();
    try {
      const applied = await admin(context, verify, 'apply', { command: proposal.command, expectedSsh: proposal.enrollment.target });
      return await finish(context, verify, proposal, applied.value);
    } catch (error) {
      // Keep the durable dispatch journal. A later explicit reconciliation may
      // only read this original receipt; no failure triggers another write.
      throw fail('PEER_SSH_SETUP_UNCONFIRMED', 409, true);
    }
  }
  async function discard(context, verify, proposalId, digest) {
    await verify();
    const result = await store.update(data => {
      const proposal = data.proposals.find(row => row.id === proposalId);
      checkProposalRecord(context, proposal, digest);
      if (proposal.phase === 'discarded') return project(proposal);
      if (proposal.phase !== 'proposed') throw fail('PEER_SSH_ORIGINAL_RECONCILIATION_REQUIRED', 409, true);
      proposal.phase = 'discarded';
      return project(proposal);
    }, verify);
    await verify(); return result;
  }
  function observeStatus(data, context) {
    const proposals = (data?.proposals ?? []).filter(row => row.scopeKey === context.scopeKey);
    const pin = data?.pins.find(row => row.scopeKey === context.scopeKey);
    const unresolved = proposals.filter(row => !terminal(row));
    let pinStatus = 'none';
    if (unresolved.some(row => !sameBinding(row.enrollment, context)) ||
      pin && (!sameBinding(pin.enrollment, context) || !isDeepStrictEqual(pin.enrollment.gateway, data.gateway))) pinStatus = 'scope_changed';
    else if (pin) pinStatus = pin.status;
    else if (unresolved.some(row => ['dispatching', 'setup_unconfirmed'].includes(row.phase))) pinStatus = 'setup_unconfirmed';
    const result = { configured: Boolean(pin || proposals.length), pinStatus, proposals: proposals.map(project) };
    if (pinStatus === 'pinned' && (!isContract('PeerSshPinReceiptV1', pin.receipt) || pin.receipt.status !== 'pinned' ||
      pin.receipt.enrollmentId !== pin.enrollment.enrollmentId || pin.receipt.generation !== pin.enrollment.generation)) throw fail('PEER_SSH_STATUS_UNAVAILABLE');
    if (!isContract('PeerSshGatewayStatusV1', result)) throw fail('PEER_SSH_STATUS_UNAVAILABLE');
    return result;
  }
  return Object.freeze({
    async resolve(target, workspacePath, verifyCurrent) {
      let data;
      try { data = await store.read(); }
      catch { return { configured: true, selection: null }; }
      const workspace = workspaceFor(target, workspacePath), key = scopeFor(target, workspace);
      const configured = data?.pins.some(row => row.scopeKey === key) || data?.proposals.some(row => row.scopeKey === key);
      if (!configured) return { configured: false, selection: null };
      try {
        const context = scope(target, workspace);
        const pin = data.pins.find(row => row.scopeKey === key && row.status === 'pinned');
        if (!pin || pin.enrollment.target.targetRevision !== context.binding.targetRevision ||
          pin.enrollment.target.accountGeneration !== context.binding.accountGeneration) return { configured: true, selection: null };
        return { configured: true, selection: await store.selection(key, () => { verifyCurrent(); context.check(); }) };
      } catch { return { configured: true, selection: null }; }
    },
    async handle(request, response, pathname) {
      const match = /^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/peer-ssh\/(prepare|apply|reconcile|revoke|status|discard)$/.exec(pathname);
      if (!match) return false;
      try {
        const session = await authorize(request);
        if (!session || session.browserAdmin !== true || session.deviceId || request.headers?.authorization !== undefined)
          throw fail('PEER_SSH_FULL_BROWSER_LOGIN_REQUIRED', 403);
        if (request.method !== 'POST' || !sameOrigin(request)) throw fail('PEER_SSH_SAME_ORIGIN_POST_REQUIRED', 403);
        const target = getTarget(match[1]);
        if (!target) throw fail('PEER_SSH_TARGET_NOT_FOUND', 404);
        const body = JSON.parse(await requestBody(request, 4096));
        if (!keys(body, ['workspacePath'], ['proposalId', 'digest'])) throw fail('PEER_SSH_ENROLLMENT_REQUEST_INVALID', 400);
        const context = scope(target, body.workspacePath);
        const verify = async () => { context.check(); if (await authorize(request) !== session) throw fail('PEER_SSH_FULL_BROWSER_LOGIN_REQUIRED', 403); context.check(); };
        await verify();
        let result;
        if (match[2] === 'prepare') result = project(await propose(context, verify, false));
        else if (match[2] === 'revoke') result = await execute(context, verify, await propose(context, verify, true), false);
        else if (match[2] === 'status') {
          const data = await store.read(); await verify();
          result = observeStatus(data, context);
        } else if (match[2] === 'discard') {
          result = await discard(context, verify, body.proposalId, body.digest);
        } else {
          const data = await store.read(); await verify();
          const proposal = data?.proposals.find(row => row.id === body.proposalId);
          checkProposal(context, proposal, body.digest);
          result = await execute(context, verify, proposal, match[2] === 'reconcile');
        }
        await verify(); jsonResponse(response, 200, result);
      } catch (error) {
        jsonResponse(response, error.status ?? 409, { error: error.externalOutcome === 'unknown' ? 'PEER_SSH_SETUP_UNCONFIRMED' :
          typeof error.code === 'string' && /^PEER_SSH_[A-Z_]+$/.test(error.code) ? error.code : 'PEER_SSH_ENROLLMENT_UNAVAILABLE',
        ...(error.externalOutcome === 'unknown' ? { externalOutcome: 'unknown' } : {}) });
      }
      return true;
    },
    async close() { closed = true; await runner.close(); await store.close(); },
  });
}

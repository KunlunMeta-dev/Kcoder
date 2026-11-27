import { SESSION_ADDRESS_EXPECTATION_FIELD, sessionAddressExpectation } from '../shared/sessionAddressExpectation.mjs';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { ROUTER_METHODS, identityContains, routerIdentity } from './agent-message-router-private.js';
import { isCapturedPeerSshTransport } from './remotes/peer-ssh-transport.mjs';

const pending = new WeakMap();

/** Compare the original canonical selector with this broker's actual Native process. */
export function guardExpectedSessionAddress(broker, client, request) {
  const params = request?.params;
  if (!params || !Object.hasOwn(params, SESSION_ADDRESS_EXPECTATION_FIELD)) return false;
  let requests = pending.get(client);
  if (!requests) pending.set(client, requests = new Set());
  const id = request.id;
  const reply = (code, message) => {
    if (broker.clients.has(client)) client.send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  let expected, owner;
  try {
    if (request.jsonrpc !== '2.0' || !(typeof id === 'string' || Number.isSafeInteger(id)) ||
        typeof request.method !== 'string' || !client.initialized || client.nativeManagementOnly ||
        requests.has(id) || requests.size >= 8) throw new Error();
    expected = sessionAddressExpectation(params[SESSION_ADDRESS_EXPECTATION_FIELD], params.threadId ?? params.sourceThreadId);
    if (params.threadId !== undefined && params.sourceThreadId !== undefined && params.threadId !== params.sourceThreadId)
      throw new Error();
    owner = requireCapturedNativeRemoteSourceClient(client.nativeRemoteSourceOwner);
  } catch { reply(-32602, 'SESSION_ADDRESS_EXPECTATION_INVALID'); return true; }
  requests.add(id);
  const child = broker.child, stdin = child?.stdin, stdout = child?.stdout;
  const authorizationOwner = client.authorizationOwner;
  const check = () => {
    if (broker.closed || !broker.clients.has(client) || !client.initialized ||
        client.authorizationOwner !== authorizationOwner || client.nativeRemoteSourceOwner !== owner ||
        broker.child !== child || child.stdin !== stdin || child.stdout !== stdout ||
        stdin?.destroyed || stdout?.destroyed || !stdin?.writable) throw new Error();
    owner.verify();
    if (broker.peerSshTransport && !isCapturedPeerSshTransport(broker.peerSshTransport, child)) throw new Error();
  };
  void (async () => {
    try {
      check(); await owner.checkCurrentAuthority(); check();
      const result = await broker.sendAgentMessageRouterRequest(ROUTER_METHODS.identity, {});
      check(); await owner.checkCurrentAuthority(); check();
      if (!result || result.error || !Object.hasOwn(result, 'result')) throw new Error();
      const identity = routerIdentity(result.result);
      if (!identityContains(identity, expected)) throw new Error();
      broker.peerSshTransport?.verifyIdentity(identity);
      const { [SESSION_ADDRESS_EXPECTATION_FIELD]: _selector, ...ordinaryParams } = params;
      check();
      // Re-enter the ordinary channel, ownership and permission checks on the
      // same held broker. No canonical selector reaches Native as authority.
      broker.receive(client, JSON.stringify({ ...request, params: ordinaryParams }));
    } catch { reply(-32034, 'SESSION_ADDRESS_EXPECTATION_UNAVAILABLE'); }
    finally { requests.delete(id); }
  })();
  return true;
}

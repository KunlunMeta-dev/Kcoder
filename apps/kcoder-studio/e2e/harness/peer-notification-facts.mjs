import { validAgentMessageAddress } from '../../shared/agentMessageMethods.mjs';

const itemMethods = new Set(['item/started', 'item/delta', 'item/completed']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const address = value => validAgentMessageAddress(value) ? { targetId: value.targetId, workspaceId: value.workspaceId, threadId: value.threadId } : null;

/** Closed metadata only. A body, URL, credential, or source proof is never copied. */
export function peerNotificationFacts(message) {
  const params = message?.params, item = params?.item;
  if (!itemMethods.has(message?.method) || !item ||
      !(item.type === 'peerAgentMessage' || item.origin === 'peer_agent' || item.role === 'peer_agent')) return null;
  const metadata = item.agentMessage ?? item.agent_message;
  return { method: message.method, itemType: item.type === 'peerAgentMessage' ? item.type : 'other_peer',
    itemRole: item.role === 'peer_agent' ? item.role : null, itemOrigin: item.origin === 'peer_agent' ? item.origin : null,
    itemId: id(item.id), serverId: id(params.serverId), hasPeerTextMarker: typeof item.text === 'string' && item.text.includes('OWNED_TUI_PEER'),
    threadId: id(params.threadId), turnId: id(params.turnId), hasTurnId: params.turnId != null,
    sequence: Number.isSafeInteger(params.sequence) ? params.sequence : null,
    messageId: id(metadata?.messageId), sourceAddress: address(metadata?.sourceAddress), targetAddress: address(metadata?.targetAddress) };
}

export function peerCapabilityFacts(message) {
  const experimental = message?.result?.capabilities?.experimental;
  if (!experimental || !Object.hasOwn(experimental, 'peerAgentMessagesV1')) return null;
  return Object.fromEntries(['peerAgentMessagesV1', 'crossSessionMessagesV1', 'crossSessionDiscoveryV1']
    .map(name => [name, experimental[name] === true]));
}

export function observeOwnedPeerBroker(Broker, record) {
  const emit = event => { try { record(event); } catch { /* Diagnostics cannot alter product delivery. */ } };
  const clients = new WeakMap(); let clientSequence = 0;
  const stdout = Broker.prototype.processStdoutLine, notify = Broker.prototype.sendServerNotification;
  Broker.prototype.processStdoutLine = function(line) {
    let notice;
    try {
      const message = JSON.parse(line), facts = peerNotificationFacts(message), caps = peerCapabilityFacts(message);
      notice = facts;
      if (facts) emit({ lane: 'native-stdout', ...facts });
      if (caps) emit({ lane: 'native-initialize', ...caps });
    } catch { /* Observation cannot change Native parsing or delivery. */ }
    const result = stdout.call(this, line);
    if (notice) emit({ lane: 'native-route-completed', ...notice });
    return result;
  };
  Broker.prototype.sendServerNotification = function(client, message) {
    const facts = peerNotificationFacts(message);
    if (!facts) return notify.call(this, client, message);
    if (!clients.has(client)) clients.set(client, ++clientSequence);
    const clientId = clients.get(client);
    emit({ lane: 'gateway-notification-attempt', clientId, ...facts, initialized: client.initialized === true,
      negotiatedPeer: client.peerAgentMessagesNegotiatedV1 === true, management: client.nativeManagementOnly === true });
    const send = client.send;
    client.send = function(value) {
      const projected = peerNotificationFacts(value);
      if (projected) emit({ lane: 'gateway-client-send', clientId, ...projected });
      return send.call(this, value);
    };
    try { return notify.call(this, client, message); }
    finally { client.send = send; }
  };
  return () => { Broker.prototype.processStdoutLine = stdout; Broker.prototype.sendServerNotification = notify; };
}

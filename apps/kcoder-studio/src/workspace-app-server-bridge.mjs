import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { createAgentMessageClientDispatcher } from './agent-message-router-gateway.js';
import { BoundedReceiveBuffer } from './bounded-receive-buffer.js';

/** Existing socket lifecycle composed with authenticated source ownership. */
export function createWorkspaceAppServerBridge({ captureRetentionAuthority,
  deviceFamilies, serversById, workspaceBrokerKey, loginContexts, mcpCallbacks,
  maxMessageBytes, frame, decodeFrames, WebSocketLivenessLease,
  scheduleWorkspaceBrokerIdle, serverHealthSignature, verifySession, agentMessageRouter, getTarget }) {
return function bridgeWorkspaceAppServer(
  socket,
  target,
  channel,
  selectedBroker,
  initialData = Buffer.alloc(0),
  callbackOrigin,
  authorizationOwner,
  authSession,
  workspacePath,
  authSessionId,
  originalDeviceOwner,
) {
  const { broker, key, nativeManagementOnly } = selectedBroker;
  const currentTarget = id => getTarget ? getTarget(id) : serversById.get(id);
  const retentionAuthority = captureRetentionAuthority({
    includeWorkspaceAccount: true,
    session: authSession, familyFor: deviceId => deviceFamilies.get(deviceId),
    target, currentTarget: () => currentTarget(target.id), workspacePath,
    brokerSelection: key, currentBrokerSelection: () => workspaceBrokerKey(currentTarget(target.id), workspacePath),
    accountIdentity: () => loginContexts.identity(authorizationOwner, target.id),
    accountGeneration: () => loginContexts.generation(authorizationOwner, target.id),
  });
  let detached = false;
  const sendWithQueueStatus = message => {
    if (detached || !socket.writable) return { queued: false, writable: false };
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    if (Buffer.byteLength(raw) > maxMessageBytes)
      throw new Error("Adapted app-server response is too large");
    const writable = socket.write(frame(raw));
    if (!writable) broker.blockStdout(client);
    return { queued: true, writable };
  };
  const client = {
    channel,
    nativeManagementOnly,
    authorizationOwner,
    retentionAuthority,
    createMcpCallbackReceiver: options => mcpCallbacks.create(callbackOrigin, options),
    send(message) { return sendWithQueueStatus(message).writable; },
    sendWithQueueStatus,
    pause() {
      socket.pause();
    },
    resume() {
      if (!socket.destroyed) socket.resume();
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
  client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({
    client, broker, sourceTarget: target, authorizationOwner, session: authSession,
    verifySession: () => verifySession(authSessionId, authSession),
    getTarget: currentTarget, targetSignature: serverHealthSignature,
    accountIdentity: (owner, id) => loginContexts.identity(owner, id),
    accountGeneration: (owner, id) => loginContexts.generation(owner, id),
    originalDeviceOwner,
  });
  if (agentMessageRouter) client.routeAgentMessage = createAgentMessageClientDispatcher({
    router: agentMessageRouter, broker, client, session: authSession, workspacePath,
    verifySession: () => verifySession(authSessionId, authSession),
  });
  broker.attach(client);
  const buffered = new BoundedReceiveBuffer(maxMessageBytes + 14);
  buffered.append(initialData);
  const fragments = [];
  const releaseStdout = () => broker.releaseStdout(client);
  socket.on("drain", releaseStdout);
  let liveness;
  const detach = () => {
    if (detached) return;
    detached = true;
    buffered.clear(); fragments.length = 0;
    socket.off("drain", releaseStdout);
    liveness?.stop();
    broker.detach(client);
    scheduleWorkspaceBrokerIdle(key, broker);
  };
  liveness = new WebSocketLivenessLease({
    sendPing: payload => socket.write(frame(payload, 9)),
    canProbe: () => !socket.isPaused(),
    onExpired: () => { try { detach(); } finally { socket.destroy(); } },
  });
  liveness.start();
  // A local end or destroy can precede the socket close event.
  const canReceive = () => !detached && !socket.destroyed && socket.writable && broker.clients.has(client);
  socket.on("data", (chunk) => {
    if (!canReceive()) return;
    try {
      buffered.append(chunk);
      // Dispatch each complete message before decoding a later frame in this read.
      const decoded = decodeFrames(buffered.bytes, fragments, raw => {
        broker.receive(client, raw);
        // Explicit detach releases the broker binding before sending its receipt.
        return canReceive();
      });
      buffered.retain(decoded.rest);
      if (!canReceive()) return;
      for (const control of decoded.controls) {
        if (control.opcode === 8) {
          detach();
          socket.end(frame(control.payload, 8));
          return;
        }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
        if (control.opcode === 10) liveness.pong(control.payload);
      }
    } catch (error) {
      try {
        client.send({
          jsonrpc: "2.0",
          method: "server/transportError",
          params: { serverId: target.id, message: error.message },
        });
      } finally {
        detach();
        socket.end(frame(Buffer.from([0x03, 0xea]), 8));
      }
    }
  });
  if (buffered.length) socket.emit("data", Buffer.alloc(0));
  socket.on("end", () => {
    detach();
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("close", detach);
  socket.on("error", detach);
};
}

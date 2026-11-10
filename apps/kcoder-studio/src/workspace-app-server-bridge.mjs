import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';

/** Existing socket lifecycle composed with authenticated source ownership. */
export function createWorkspaceAppServerBridge({ captureRetentionAuthority,
  mobileDeviceFamilies, serversById, workspaceBrokerKey, loginContexts, mcpCallbacks,
  maxMessageBytes, frame, decodeFrames, WebSocketLivenessLease,
  scheduleWorkspaceBrokerIdle, serverHealthSignature, verifySession }) {
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
) {
  const { broker, key, nativeManagementOnly } = selectedBroker;
  const retentionAuthority = captureRetentionAuthority({
    includeWorkspaceAccount: true,
    session: authSession, familyFor: deviceId => mobileDeviceFamilies.get(deviceId),
    target, currentTarget: () => serversById.get(target.id), workspacePath,
    brokerSelection: key, currentBrokerSelection: () => workspaceBrokerKey(serversById.get(target.id), workspacePath),
    accountIdentity: () => loginContexts.identity(authorizationOwner, target.id),
    accountGeneration: () => loginContexts.generation(authorizationOwner, target.id),
  });
  const sendWithQueueStatus = message => {
    if (!socket.writable) return { queued: false, writable: false };
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    if (Buffer.byteLength(raw) > maxMessageBytes)
      throw new Error("Adapted app-server response is too large");
    const writable = socket.write(frame(raw));
    if (!writable) {
      broker.blockStdout(client);
      socket.once("drain", () => broker.releaseStdout(client));
    }
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
    getTarget: id => serversById.get(id), targetSignature: serverHealthSignature,
    accountIdentity: (owner, id) => loginContexts.identity(owner, id),
    accountGeneration: (owner, id) => loginContexts.generation(owner, id),
  });
  broker.attach(client);
  let buffered = Buffer.from(initialData);
  const fragments = [];
  let detached = false;
  let liveness;
  const detach = () => {
    if (detached) return;
    detached = true;
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
  socket.on("data", (chunk) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeFrames(buffered, fragments);
      buffered = decoded.rest;
      for (const control of decoded.controls) {
        if (control.opcode === 8) {
          socket.end(frame(control.payload, 8));
          return;
        }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
        if (control.opcode === 10) liveness.pong(control.payload);
      }
      for (const raw of decoded.messages) broker.receive(client, raw);
    } catch (error) {
      client.send({
        jsonrpc: "2.0",
        method: "server/transportError",
        params: { serverId: target.id, message: error.message },
      });
      socket.end(frame(Buffer.from([0x03, 0xea]), 8));
    }
  });
  if (buffered.length) socket.emit("data", Buffer.alloc(0));
  socket.on("end", () => {
    detach();
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("close", detach);
  socket.on("error", detach);
}
;
}

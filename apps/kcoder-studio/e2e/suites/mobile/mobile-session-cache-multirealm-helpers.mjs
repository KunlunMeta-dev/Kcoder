/** Parse only JSON-RPC metadata needed to correlate the held Browser response. */
export function parseRpcFrame(raw) {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) return null;
  try { return JSON.parse(Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : raw); }
  catch { return null; }
}

/** Wait until Playwright has installed the page-scoped Gateway RPC WebSocket route. */
export async function registerPageRpcWebSocketRoute(page, handler) {
  if (!page || typeof page.routeWebSocket !== "function") {
    throw new TypeError("Playwright page must expose routeWebSocket");
  }
  await page.routeWebSocket("**/rpc*", handler);
}

/** Install a page-local witness that stores only the ID and SHA-256 of received RPC response frames. */
export async function installRpcResponseReceiptWitness(page) {
  if (!page || typeof page.addInitScript !== "function") {
    throw new TypeError("Playwright page must expose addInitScript");
  }
  await page.addInitScript(() => {
    const witnessKey = "__mobileMultirealmRpcResponseReceiptsV1";
    Object.defineProperty(globalThis, witnessKey, {
      value: [],
      configurable: false,
      enumerable: false,
      writable: false,
    });

    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    const addEventListener = WebSocket.prototype.addEventListener;
    if (typeof descriptor?.set !== "function" || typeof descriptor.get !== "function" ||
        typeof addEventListener !== "function") return;

    const observedSockets = new WeakSet();
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(handler) {
        descriptor.set.call(this, handler);
        if (observedSockets.has(this) || typeof handler !== "function") return;
        let isRpcSocket = false;
        try { isRpcSocket = new URL(this.url).pathname.endsWith("/rpc"); } catch { /* Invalid URLs are not RPC sockets. */ }
        if (!isRpcSocket) return;
        observedSockets.add(this);
        addEventListener.call(this, "message", event => {
          const raw = event?.data;
          if (typeof raw !== "string") return;
          let frame;
          try { frame = JSON.parse(raw); } catch { return; }
          if (!frame || frame.id === undefined || frame.method !== undefined ||
              (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))) return;
          void crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)).then(digest => {
            const bytes = new Uint8Array(digest);
            const sha256 = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
            const receipts = globalThis[witnessKey];
            receipts.push({ id: String(frame.id), sha256 });
            if (receipts.length > 64) receipts.splice(0, receipts.length - 64);
          }).catch(() => {});
        });
      },
    });
  });
}

/** Own the two sides of one routed RPC socket and make close propagation explicit. */
export function createPageRpcBridgeConnection(pageSocket, serverSocket) {
  if (!pageSocket || typeof pageSocket.onClose !== "function" ||
      typeof pageSocket.onMessage !== "function" || typeof pageSocket.send !== "function" ||
      typeof pageSocket.close !== "function") {
    throw new TypeError("Playwright page-side WebSocketRoute is required");
  }
  if (!serverSocket || typeof serverSocket.onClose !== "function" ||
      typeof serverSocket.onMessage !== "function" || typeof serverSocket.send !== "function" ||
      typeof serverSocket.close !== "function") {
    throw new TypeError("Playwright server-side WebSocketRoute is required");
  }

  const state = {
    clientClosed: false,
    serverClosed: false,
    serverCloseRequested: false,
    serverClosedAtMs: null,
    clientClosedAtMs: null,
    droppedPageFramesAfterServerClose: 0,
  };

  pageSocket.onClose(() => {
    state.clientClosed = true;
    state.clientClosedAtMs = performance.now();
    if (!state.serverClosed) void serverSocket.close().catch(() => {});
  });

  serverSocket.onClose(() => {
    state.serverClosed = true;
    state.serverClosedAtMs = performance.now();
    if (!state.serverCloseRequested && !state.clientClosed) void pageSocket.close().catch(() => {});
  });

  return {
    state,
    async disconnectServerPreservingPage() {
      if (state.clientClosed) throw new Error("cannot preserve an already-closed page-side WebSocket");
      if (state.serverClosed) return false;
      state.serverCloseRequested = true;
      await serverSocket.close();
      return true;
    },
    sendToServer(message) {
      if (state.serverClosed) {
        state.droppedPageFramesAfterServerClose++;
        return false;
      }
      serverSocket.send(message);
      return true;
    },
    sendToPage(message) {
      if (state.clientClosed) return false;
      pageSocket.send(message);
      return true;
    },
  };
}

/** A response is eligible only when it is the exact successful indexed read for this thread. */
export function isOwnedIndexedAuthorityResponse(request, response, expectedThreadId) {
  if (!request || !response || typeof expectedThreadId !== "string" || !expectedThreadId) return false;
  if (request.method !== "thread/read/indexed" || request.threadId !== expectedThreadId ||
      String(request.id) !== String(response.id) || response.error || !response.result) return false;
  const result = response.result;
  if (result.thread?.id !== expectedThreadId || !Array.isArray(result.messages) ||
      !Number.isSafeInteger(result.rangeStart) || !Number.isSafeInteger(result.rangeEnd) ||
      result.rangeStart < 0 || result.rangeEnd < result.rangeStart ||
      result.rangeEnd - result.rangeStart !== result.messages.length) return false;
  return true;
}

/** A deletion snapshot proves the exact prior slot/key was tombstoned and its old row was removed. */
export function isExactThreadInvalidationSnapshot(snapshot, beforeTarget) {
  if (!beforeTarget || typeof beforeTarget.key !== "string" || !Number.isSafeInteger(beforeTarget.slot) ||
      !Number.isSafeInteger(beforeTarget.dataRevision) || !snapshot?.ready || !snapshot.manifest || !Array.isArray(snapshot.entries) ||
      !Array.isArray(snapshot.manifest.invalidations) || !Array.isArray(snapshot.slotRevisions)) return false;
  const tombstone = snapshot.manifest.invalidations.find(item => item?.key === `t:${beforeTarget.key}`);
  const slotOwner = snapshot.entries.find(row => row.slot === beforeTarget.slot);
  const oldSlotRevisionRetained = snapshot.slotRevisions.some(row =>
    row.slot === beforeTarget.slot && row.revision === beforeTarget.dataRevision);
  return !snapshot.entries.some(row => row.key === beforeTarget.key) &&
    snapshot.manifest.lastKey !== beforeTarget.key &&
    Number.isSafeInteger(tombstone?.revision) && tombstone.revision > beforeTarget.dataRevision &&
    (!slotOwner || slotOwner.key !== beforeTarget.key) && !oldSlotRevisionRetained;
}

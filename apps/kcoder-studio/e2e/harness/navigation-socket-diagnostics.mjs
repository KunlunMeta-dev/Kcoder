const CANCELLED_CONNECT = 'WebSocket is closed before the connection is established.';

/** Passive CDP observations: no WebSocket constructor, readyState or connection behavior is changed. */
export async function observeNavigationSockets(page, { gatewayBaseUrl, workspacePath, serverId = 'local', getPhase = () => null } = {}) {
  const expected = new URL(gatewayBaseUrl);
  const protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  const rpcPath = `${expected.pathname.replace(/\/+$/, '')}/rpc`;
  const session = await page.context().newCDPSession(page);
  const sockets = new Map(), contexts = new Map(), errors = [], documents = [], navigations = [], lifecycle = [];
  const binding = '__kcoderE2eNavigationLifecycle';
  let document = null, navigation = null, sequence = 0, ordinal = 0, overflow = 0;
  // Created/binding CDP payloads have no shared source timestamp. These ordinals
  // linearize observations on this one session; they do not claim physical
  // creation timestamps. Wall-clock fields are diagnostic only.
  const tick = () => ++ordinal;
  const safe = text => String(text).replace(/\b(?:wss?|https?):\/\/[^\s'"<>]+/gi, '[REDACTED_URL]').slice(0, 500);
  const stackFrames = (stack, depth = 0) => !stack || depth >= 3 ? [] : [
    ...(stack.callFrames ?? []).slice(0, 6).map(frame => {
      let source = '[unknown]';
      try { const url = new URL(frame.url); source = url.origin === expected.origin ? url.pathname : '[external]'; } catch {}
      return { functionName: safe(frame.functionName ?? ''), source, line: frame.lineNumber + 1, column: frame.columnNumber + 1 };
    }), ...stackFrames(stack.parent, depth + 1),
  ];
  const updateDocument = (frame, eventOrdinal = null) => {
    if (frame.parentId) return;
    if (document?.loaderId === frame.loaderId && document?.frameId === frame.id) return;
    document = { epoch: documents.length, frameId: frame.id, loaderId: frame.loaderId ?? null };
    documents.push({ ...document, at: Date.now(), ordinal: eventOrdinal });
    if (navigation && eventOrdinal && document.loaderId !== navigation.fromLoaderId)
      navigation.commitOrdinal = eventOrdinal;
  };
  const route = raw => {
    try {
      const url = new URL(raw), keys = [...url.searchParams.keys()];
      const matches = url.protocol === protocol && url.host === expected.host && url.pathname === rpcPath &&
        !url.username && !url.password && Boolean(url.searchParams.get('token')) &&
        url.searchParams.get('server') === serverId && (url.searchParams.get('channel') ?? 'runtime') === 'runtime' &&
        (!url.searchParams.has('workspace') || url.searchParams.get('workspace') === workspacePath) &&
        new Set(keys).size === keys.length && keys.every(key => ['token', 'server', 'channel', 'workspace'].includes(key));
      return { matches, origin: url.origin, rpcPathMatches: url.pathname === rpcPath };
    } catch { return { matches: false }; }
  };
  const pendingIn = (epoch, loader) => [...sockets.values()].filter(socket =>
    socket.documentEpoch === epoch && socket.loaderId === loader && !socket.closed &&
    !socket.established && !socket.handshakeResponse).map(socket => socket.id);
  session.on('Page.frameNavigated', ({ frame }) => updateDocument(frame, tick()));
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.isDefault && context.auxData?.frameId === document?.frameId)
      contexts.set(context.id, { epoch: document.epoch, loaderId: document.loaderId });
  });
  session.on('Runtime.bindingCalled', event => {
    const eventOrdinal = tick();
    if (event.name !== binding || lifecycle.length >= 64) return;
    try {
      const value = JSON.parse(event.payload), owner = contexts.get(event.executionContextId);
      if (!['document-observed', 'beforeunload-capture', 'beforeunload-after-bootstrap-listeners', 'pagehide'].includes(value.kind)) return;
      lifecycle.push({ kind: value.kind, at: value.at, documentTimeOrigin: value.timeOrigin, ordinal: eventOrdinal,
        epoch: owner?.epoch ?? null, loaderId: owner?.loaderId ?? null,
        ipcBridgeAvailable: value.ipcBridgeAvailable === true, observedAt: Date.now() });
      if (!navigation || !owner || owner.epoch !== navigation.fromDocumentEpoch ||
        owner.loaderId !== navigation.fromLoaderId || !owner.loaderId) return;
      if (value.kind === 'beforeunload-capture' && value.ipcBridgeAvailable === true && !navigation.unloadCapture) {
        navigation.unloadCapture = { ordinal: eventOrdinal, pendingSocketIds: pendingIn(owner.epoch, owner.loaderId) };
      }
      if (value.kind === 'beforeunload-after-bootstrap-listeners' && value.ipcBridgeAvailable === false &&
        navigation.unloadCapture?.ordinal < eventOrdinal) navigation.retiredOrdinal = eventOrdinal;
    } catch {}
  });
  session.on('Network.webSocketCreated', event => {
    const createdOrdinal = tick();
    if (sockets.size >= 256) { overflow += 1; return; }
    sockets.set(event.requestId, { id: `socket-${++sequence}`, documentEpoch: document?.epoch ?? null,
      loaderId: document?.loaderId ?? null, createdAt: Date.now(), createdOrdinal, route: route(event.url),
      established: false, handshakeResponse: false, closed: false, phaseAtCreation: getPhase(),
      initiator: stackFrames(event.initiator?.stack) });
  });
  session.on('Network.webSocketHandshakeResponseReceived', event => {
    tick();
    const socket = sockets.get(event.requestId);
    if (socket) { socket.handshakeResponse = true; socket.established ||= event.response?.status === 101; }
  });
  for (const name of ['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'])
    session.on(name, event => { tick(); const socket = sockets.get(event.requestId); if (socket) socket.established = true; });
  session.on('Network.webSocketClosed', event => {
    tick();
    const socket = sockets.get(event.requestId);
    if (socket) socket.closed = true;
  });
  session.on('Network.webSocketFrameError', event => {
    const eventOrdinal = tick();
    const socket = sockets.get(event.requestId);
    errors.push({ text: safe(event.errorMessage), at: Date.now(), stage: getPhase(),
      socketId: socket?.id ?? null, socketDocumentEpoch: socket?.documentEpoch ?? null,
      currentDocumentEpoch: document?.epoch ?? null, loaderId: socket?.loaderId ?? null,
      established: socket?.established ?? null, handshakeResponse: socket?.handshakeResponse ?? null,
      route: socket?.route ?? null, navigationId: navigation?.id ?? null,
      ordinal: eventOrdinal, createdOrdinal: socket?.createdOrdinal ?? null,
      exactCancelledConnect: event.errorMessage === CANCELLED_CONNECT, disposition: 'unexpected' });
  });
  try {
    await session.send('Page.enable');
    updateDocument((await session.send('Page.getFrameTree')).frameTree.frame);
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: binding });
    const source = `(() => {
      if (window !== window.top) return;
      const report = kind => {
        if (typeof window.${binding} !== 'function') return;
        window.${binding}(JSON.stringify({kind, at: Date.now(), timeOrigin: performance.timeOrigin,
          ipcBridgeAvailable: typeof window.__ELECTRON_INTERNALS__?.invoke === 'function'}));
      };
      report('document-observed');
      addEventListener('beforeunload', () => report('beforeunload-capture'), {capture:true});
      addEventListener('pagehide', () => report('pagehide'), {capture:true});
      const late = () => addEventListener('beforeunload', () => report('beforeunload-after-bootstrap-listeners'));
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', late, {once:true}); else late();
    })()`;
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    await session.send('Runtime.evaluate', { expression: source });
    await session.send('Network.enable');
  } catch (error) { await session.detach().catch(() => {}); throw error; }
  return {
    errors,
    snapshot: () => ({ orderingBasis: 'single CDP session observation ordinals; not physical creation timestamps', documents, navigations, lifecycle, sockets: [...sockets.values()], overflow }),
    stop: () => session.detach(),
    async reload(options = { waitUntil: 'domcontentloaded' }) {
      if (navigation) throw new Error('overlapping owned reload observations');
      const record = { id: `reload-${navigations.length + 1}`, fromDocumentEpoch: document?.epoch ?? null,
        fromLoaderId: document?.loaderId ?? null, startedAt: Date.now(), stage: getPhase(), status: 'reloading',
        intentOrdinal: ordinal, pendingSocketIds: pendingIn(document?.epoch, document?.loaderId),
        unloadCapture: null, retiredOrdinal: null, commitOrdinal: null };
      navigations.push(record); navigation = record;
      try {
        const result = await page.reload(options);
        updateDocument((await session.send('Page.getFrameTree')).frameTree.frame);
        record.status = 'completed';
        return result;
      } catch (error) { record.status = 'failed'; throw error; }
      finally {
        record.completedAt = Date.now(); record.toDocumentEpoch = document?.epoch ?? null;
        if (record.status === 'completed' && record.unloadCapture && record.retiredOrdinal > record.unloadCapture.ordinal &&
          record.commitOrdinal > record.retiredOrdinal && record.toDocumentEpoch > record.fromDocumentEpoch) {
          for (const error of errors.filter(item => item.navigationId === record.id)) {
            const socket = [...sockets.values()].find(item => item.id === error.socketId);
            if (socket && socket.documentEpoch === record.fromDocumentEpoch && socket.loaderId === record.fromLoaderId &&
              socket.route.matches && !socket.established && !socket.handshakeResponse &&
              record.unloadCapture.pendingSocketIds.includes(socket.id) &&
              socket.createdOrdinal < record.unloadCapture.ordinal && error.ordinal > record.unloadCapture.ordinal &&
              error.exactCancelledConnect && error.established === false && error.handshakeResponse === false)
              error.disposition = 'expected-owned-reload-teardown';
          }
        }
        navigation = null;
      }
    },
  };
}

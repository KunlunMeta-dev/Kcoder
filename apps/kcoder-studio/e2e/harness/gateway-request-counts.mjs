const compiledAsset = /^\/assets\/[A-Za-z0-9_.~-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const requestIdentity = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const increment = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

export const gatewayRequestCounts = () => ({ http: {}, resources: {}, statuses: {}, responses: {},
  firstSeenGatewayResponses: {}, reusedGatewayResponseHeaders: {}, missingGatewayResponseHeaders: {}, assets: {} });

const requestDomains = [
  ['authentication', /\/api\/(?:kcoder-account|session)(?:\/|$)|\/account(?:\/|$)/, /^(?:auth|account)\//],
  ['devices', /\/api\/servers(?:\/|$)/, /^(?:initialize$|device\/|terminal\/|server\/resources\/|runtime\.workspaces?\.|runtime\.worktrees\.)/],
  ['sessions', /\/api\/(?:tasks|threads)(?:\/|$)/, /^(?:thread\/|turn\/|gateway\/thread\/|asyncQuestion\/|agent\/|migration\/history\/)/],
  ['tools', /\/api\/tools(?:\/|$)/, /^tools?\//],
  ['configuration', /\/api\/(?:models|settings)(?:\/|$)/, /^(?:runtime\.(?:models|providers|context)\.|integrations\/|settings\/|session\/modes$|skills\/|plugin\/|agentDefinitions\/|migration\/memory\/|mcp\/list$|marketplace\/list$)/],
  ['channels', /\/api\/channels(?:\/|$)/, /^runtime\.channels\./],
  ['experience', /\/api\/experience(?:\/|$)/, /^(?:experience|runtime\.experience)[/.]/],
  ['automation', /\/api\/(?:workflows|cron)(?:\/|$)/, /^(?:cron\/|workflow\/|work\/)/],
  ['other', /.*/, /.*/],
];

/** Count wire requests once by domain; responses and authority verdicts are separate evidence. */
export function summarizeReadDomains(phases) {
  const empty = () => Object.fromEntries(requestDomains.map(([name]) => [name, { http: 0, rpc: 0 }]));
  const totals = empty();
  const rows = phases.map(phase => {
    const domains = empty();
    for (const [field, kind, pattern] of [['http', 'http', 1], ['rpcRequests', 'rpc', 2]]) {
      for (const [method, count] of Object.entries(phase[field] ?? {})) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid request counter');
        const [name] = requestDomains.find(row => row[pattern].test(method));
        domains[name][kind] += count;
        totals[name][kind] += count;
      }
    }
    return { name: phase.name, status: phase.status ?? 'unknown', domains,
      rpcRequestsObserved: Object.hasOwn(phase, 'rpcRequests'),
      browserSessionInspections: phase.auth?.started ?? 0,
      ...(phase.auth?.coalesced === undefined ? {} : {
        browserSessionCoalescedReads: phase.auth.coalesced,
        browserSessionReadCalls: phase.auth.queued + phase.auth.coalesced,
      }),
      ...(phase.firstScreen ? { firstScreen: phase.firstScreen } : {}) };
  });
  return { classification: 'Transport domains; RPC requests can include writes and leases, not just reads',
    rpcRequestsObserved: rows.every(row => row.rpcRequestsObserved), totals, phases: rows };
}

/** Run-local correlation only; raw catalog identities never enter the returned evidence. */
export function createModelCatalogReadSampler() {
  const scopes = new Map();
  return (params = {}) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const fields = ['deviceId', 'workspacePath', 'taskId', 'threadId'].map(key => params[key] ?? null);
    if (fields.some(value => value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 4096)))
      return;
    if (params.includeHidden != null && typeof params.includeHidden !== 'boolean')
      return;
    const key = JSON.stringify([...fields, params.includeHidden ?? null]);
    if (!scopes.has(key)) {
      if (scopes.size >= 128) return;
      scopes.set(key, scopes.size + 1);
    }
    return { scopeOrdinal: scopes.get(key), explicitDevice: Boolean(fields[0]),
      explicitWorkspace: Boolean(fields[1]), explicitTask: Boolean(fields[2]), threadBound: Boolean(fields[3]) };
  };
}

/** One passive CDP stream owns wire counts and directory lifetimes, including route transitions. */
export async function observeGatewayRequests(context, page, origin, currentPhase) {
  const session = await page.context().newCDPSession(page);
  const pending = new Map(), seen = new Set(), documents = new Map(), start = performance.now();
  const directoryReads = { requests: [], healthRequests: [], overflow: 0 };
  let failure;
  const guard = operation => value => { try { operation(value); } catch (error) { failure ??= error; } };
  const frames = (stack, depth = 0) => !stack || depth >= 3 ? [] : [
    ...(stack.callFrames ?? []).slice(0, 12).flatMap(frame => {
      let source;
      try { const url = new URL(frame.url); if (url.origin === origin && compiledAsset.test(url.pathname)) source = url.pathname; } catch {}
      if (!source) return [];
      return [{ source, functionName: /^[A-Za-z_$][A-Za-z0-9_.$ <>-]{0,100}$/.test(frame.functionName ?? '') ? frame.functionName : '',
        line: frame.lineNumber + 1, column: frame.columnNumber + 1 }];
    }), ...frames(stack.parent, depth + 1),
  ];
  const response = guard(event => {
    const owner = pending.get(event.requestId); if (!owner) return;
    const { phase, kind, path, row } = owner;
    const value = event.response;
    if (row) { row.status = value.status; row.responseMs = performance.now() - start; }
    if (!phase) return;
    increment(phase.responses, kind);
    if (path.startsWith('/api/')) increment(phase.statuses, value.status);
    const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const id = headers['x-request-id'];
    const known = typeof id === 'string' && requestIdentity.test(id);
    const repeated = known && seen.has(id);
    increment(known ? repeated ? phase.reusedGatewayResponseHeaders : phase.firstSeenGatewayResponses
      : phase.missingGatewayResponseHeaders, kind);
    if (known) { seen.add(id); if (seen.size > 32768) throw new Error('Gateway response observation capacity exceeded'); }
    if (!compiledAsset.test(path)) return;
    if (!Object.hasOwn(phase.assets, path) && Object.keys(phase.assets).length >= 2048)
      throw new Error('Compiled asset observation capacity exceeded');
    const asset = phase.assets[path] ??= { responses: 0, firstSeen: 0, reused: 0, missing: 0, policies: {}, statuses: {} };
    asset.responses++; asset[known ? repeated ? 'reused' : 'firstSeen' : 'missing']++;
    const policy = headers['cache-control'] || '';
    increment(asset.policies, policy.includes('no-store') ? 'no-store' : policy.includes('immutable') ? 'immutable' : 'other');
    increment(asset.statuses, value.status);
  });
  const request = guard(event => {
    // CDP emits a redirect's response on the next request event, reusing requestId.
    if (event.redirectResponse) {
      response({ requestId: event.requestId, response: event.redirectResponse });
      complete(event, 'redirected');
    }
    pending.delete(event.requestId);
    const url = new URL(event.request.url);
    if (url.origin !== origin) return;
    const phase = currentPhase(), kind = (event.type || 'Other').toLowerCase(), path = url.pathname;
    if (phase) {
      increment(phase.resources, kind);
      if (path.startsWith('/api/')) increment(phase.http, `${event.request.method} ${path}`);
    }
    const rows = event.request.method !== 'GET' ? null : path === '/api/servers' ? directoryReads.requests
      : path === '/api/servers/status' ? directoryReads.healthRequests : null;
    let row;
    if (rows) {
      if (rows.length >= 128) directoryReads.overflow++;
      else {
        if (event.loaderId && !documents.has(event.loaderId)) documents.set(event.loaderId, documents.size + 1);
        row = { ordinal: rows.length + 1, phase: phase?.name ?? null,
          documentOrdinal: documents.get(event.loaderId) ?? null,
          startedMs: performance.now() - start, initiator: frames(event.initiator?.stack) };
        rows.push(row);
      }
    }
    if (pending.size >= 32768) throw new Error('Gateway pending observation capacity exceeded');
    pending.set(event.requestId, { phase, kind, path, row });
  });
  const complete = (event, outcome) => {
    const row = pending.get(event.requestId)?.row;
    if (row) {
      row.outcome = outcome; row.completedMs = performance.now() - start;
      row.completedPhase = currentPhase()?.name ?? null;
    }
    pending.delete(event.requestId);
  };
  const finished = guard(event => complete(event, 'completed'));
  const failed = guard(event => complete(event, event.canceled ? 'cancelled' : 'failed'));
  session.on('Network.requestWillBeSent', request); session.on('Network.responseReceived', response);
  session.on('Network.loadingFinished', finished); session.on('Network.loadingFailed', failed);
  context.addCleanup('detach Gateway wire observations', async () => {
    session.off('Network.requestWillBeSent', request); session.off('Network.responseReceived', response);
    session.off('Network.loadingFinished', finished); session.off('Network.loadingFailed', failed);
    pending.clear(); seen.clear(); documents.clear();
    try { await session.detach(); }
    catch (error) { if (!page.isClosed()) throw error; }
  });
  await session.send('Network.enable');
  return { validate: () => { if (failure) throw failure; }, directoryReads };
}

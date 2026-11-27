import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export async function startOAuthMcpFixture(context, { manualApproval = false, manualClient = null, resourceScopes = [], tokenResponseFields = {}, beforeTokenResponse = null, tokenFailure = false, toolsListFailure = false, isTokenRevoked = () => false, accountSubjects = [], providerRevocation = null, beforeRevocationResponse = null } = {}) {
  const token = `opaque:${randomBytes(24).toString('hex')}|part=one.two`;
  context.registerSecret(token);
  if (manualClient?.secret) context.registerSecret(manualClient.secret);
  const grants = new Map();
  const events = [];
  const providerRevocations = [], fixtureErrors = [];
  const requestCounts = {mcp:0,token:0,refresh:0};
  const revocationModes = new Map();
  let revocationAdvertised = !!providerRevocation;

  const accountEvents = [];
  const recordAccount = event => accountEvents.push({ ...event, atMs: Date.now() });
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const accountEpochs = new Map();
  const expiredSubjects = new Set();
  const rejectedRefreshSubjects = new Set();
  const lostRefreshSubjects = new Set();
  const nextAccessLifetimes = new Map();
  const issueAccountTokens = subject => {
    const epoch = (accountEpochs.get(subject) ?? 0) + 1;
    accountEpochs.set(subject, epoch);
    const access = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    context.registerSecret(access); context.registerSecret(refresh);
    accessTokens.set(access, { subject, epoch });
    refreshTokens.set(refresh, { subject, epoch });
    expiredSubjects.delete(subject);
    const lifetime = nextAccessLifetimes.get(subject) ?? 3600;
    nextAccessLifetimes.delete(subject);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: lifetime };
  };
  let root;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, root);
      const json = (status, body, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
      };
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_048_576) throw new Error('Fixture request too large');
      }
      if (url.pathname === '/metadata') return json(200, { resource: root, authorization_servers: [root], scopes_supported: resourceScopes });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, {
        issuer: root, authorization_endpoint: root + '/authorize', token_endpoint: root + '/token',
        registration_endpoint: manualClient ? undefined : root + '/register', response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: [manualClient?.method ?? 'none'],
        ...(revocationAdvertised ? { revocation_endpoint: root + '/revoke', revocation_endpoint_auth_methods_supported: [manualClient?.method ?? 'none'] } : {}),
      });
      if (url.pathname === '/register') {
        if (manualClient) return json(404, {});
        events.push('register');
        const params = JSON.parse(body);
        return json(201, { client_id: 'fixture-client', token_endpoint_auth_method: 'none', redirect_uris: params.redirect_uris });
      }
      if (url.pathname === '/authorize' && resourceScopes.some(scope => !(url.searchParams.get('scope') || '').split(' ').includes(scope))) {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', url.searchParams.get('state'));
        callback.searchParams.set('error', 'invalid_scope');
        events.push('invalid-scope');
        response.writeHead(302, { location: callback.href, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (url.pathname === '/authorize' && manualApproval) {
        if (accountSubjects.length) {
          const links = accountSubjects.map(subject => {
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(subject)) throw new Error('Invalid fixture subject');
            const target = new URL('/approve' + url.search, root);
            target.searchParams.set('subject', subject);
            return `<a id="approve-${subject}" href="${target.pathname}${target.search.replaceAll('&', '&amp;')}">Approve ${subject}</a>`;
          });
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(`<!doctype html><title>Owned OAuth subjects</title>${links.join(' ')}`);
          return;
        }
        const target = ('/approve' + url.search).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`<!doctype html><title>Owned OAuth fixture</title><a id="approve" href="${target}">Approve fixture access</a>`);
        return;
      }
      if (url.pathname === '/authorize' || url.pathname === '/approve') {
        const subject = url.searchParams.get('subject');
        if (accountSubjects.length && !accountSubjects.includes(subject)) return json(400, { error: 'invalid_subject' });
        const code = randomBytes(24).toString('hex');
        context.registerSecret(code);
        grants.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri'), subject });
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', url.searchParams.get('state'));
        callback.searchParams.set('code', code);
        response.writeHead(302, { location: callback.href, 'cache-control': 'no-store' });
        response.end();
        events.push('browser-authorize');
        return;
      }
      if (url.pathname === '/token') {
        requestCounts.token++;
        const form = new URLSearchParams(body);
        if(form.get('grant_type')==='refresh_token')requestCounts.refresh++;
        if (accountSubjects.length && form.get('grant_type') === 'refresh_token') {
          const saved = refreshTokens.get(form.get('refresh_token'));
          if (!saved || form.get('resource') !== root + '/') return json(400, { error: 'invalid_grant' });
          refreshTokens.delete(form.get('refresh_token'));
          recordAccount({ type: 'refresh', subject: saved.subject, epoch: saved.epoch });
          if (rejectedRefreshSubjects.has(saved.subject)) return json(400, { error: 'invalid_grant' });
          if (lostRefreshSubjects.has(saved.subject)) {
            lostRefreshSubjects.delete(saved.subject);
            issueAccountTokens(saved.subject);
            recordAccount({ type: 'refresh-response-lost', subject: saved.subject, epoch: saved.epoch });
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1024' });
            response.write('{');
            response.destroy();
            return;
          }
          return json(200, issueAccountTokens(saved.subject));
        }
        if (manualClient) {
          const basic = 'Basic ' + Buffer.from(manualClient.id + ':' + manualClient.secret).toString('base64');
          const valid = manualClient.method === 'client_secret_basic'
            ? request.headers.authorization === basic
            : manualClient.method === 'client_secret_post'
              ? form.get('client_id') === manualClient.id && form.get('client_secret') === manualClient.secret
              : form.get('client_id') === manualClient.id;
          if (!valid) {
            events.push('invalid-client');
            return json(401, { error: 'invalid_client' });
          }
        }
        const grant = grants.get(form.get('code'));
        const digest = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!grant || digest !== grant.challenge || form.get('redirect_uri') !== grant.redirect || form.get('resource') !== root + '/') {
          return json(400, { error: 'invalid_grant' });
        }
        grants.delete(form.get('code'));
        events.push('token-exchange');
        if (accountSubjects.length) {
          recordAccount({ type: 'authorize', subject: grant.subject });
          return json(200, { ...issueAccountTokens(grant.subject), ...tokenResponseFields });
        }
        if (beforeTokenResponse) await beforeTokenResponse();
        if (tokenFailure) return json(503, { error: 'temporarily_unavailable' });
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, ...tokenResponseFields });
      }
      if (url.pathname === '/revoke' && providerRevocation) {
        const form = new URLSearchParams(body), supplied = form.get('token');
        const method = manualClient?.method ?? 'none';
        const authenticated = method === 'client_secret_basic'
          ? request.headers.authorization === 'Basic ' + Buffer.from(manualClient.id + ':' + manualClient.secret).toString('base64')
          : form.get('client_id') === (manualClient?.id ?? 'fixture-client') && (method !== 'client_secret_post' || form.get('client_secret') === manualClient.secret);
        if (!authenticated) return json(401, {error:'invalid_client'});
        const refresh = refreshTokens.get(supplied), access = accessTokens.get(supplied), original = refresh ?? access;
        const subject = original?.subject ?? null;
        const mode = revocationModes.get(subject) ?? 'accepted';
        const observation = {sequence:providerRevocations.length + 1,subject,epoch:original?.epoch ?? null,tokenKind:refresh?'refresh_token':access?'access_token':'unknown',mode,atMs:Date.now(),effectApplied:false};
        providerRevocations.push(observation);
        if (beforeRevocationResponse) await beforeRevocationResponse({...observation});
        if (mode === 'unsupported') return json(400,{error:'unsupported_token_type'});
        if (original) {
          for (const [value, binding] of accessTokens) if(binding.subject === subject && binding.epoch === original.epoch) accessTokens.delete(value);
          for (const [value, binding] of refreshTokens) if(binding.subject === subject && binding.epoch === original.epoch) refreshTokens.delete(value);
          observation.effectApplied = true;
        }
        recordAccount({type:'provider-revocation',subject,epoch:original?.epoch??null,outcome:mode==='lost-ack'?'response-lost':'accepted'});
        if (mode === 'lost-ack') { response.destroy(); return; }
        return json(200,{});
      }
      if (url.pathname !== '/mcp') return json(404, {});
      requestCounts.mcp++;
      const account = accountSubjects.length ? accessTokens.get(String(request.headers.authorization ?? '').replace(/^Bearer /, '')) : null;
      if (isTokenRevoked() || (accountSubjects.length ? !account || expiredSubjects.has(account.subject) : request.headers.authorization !== 'Bearer ' + token)) {
        if (account) recordAccount({ type: 'unauthorized', subject: account.subject, epoch: account.epoch });
        events.push('unauthorized');
        return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${root}/metadata"` });
      }
      const rpc = JSON.parse(body);
      if (account) recordAccount({ type: rpc.method, subject: account.subject, epoch: account.epoch });
      events.push(rpc.method);
      if (rpc.method === 'tools/list' && toolsListFailure) return json(503, { error: 'fixture_discovery_unavailable' });
      if (rpc.id === undefined) {
        response.writeHead(202); response.end(); return;
      }
      const result = rpc.method === 'initialize' ? {
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' },
      } : rpc.method === 'tools/list' ? { tools: [{ name: 'oauth_probe', description: 'Owned OAuth fixture tool', inputSchema: { type: 'object', properties: {} } }] }
        : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: account ? `OAUTH_SUBJECT_${account.subject}_RESOURCE_${account.subject}_ONLY` : 'OAUTH_TOOL_OK' }] } : {};
      json(200, { jsonrpc: '2.0', id: rpc.id, result });
    })().catch(() => { fixtureErrors.push('OAUTH_FIXTURE_HANDLER_FAILED'); if(!response.destroyed) {response.writeHead(500); response.end('Fixture failed');} });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.addCleanup('close OAuth MCP fixture', async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  context.registerPort('oauth-mcp-fixture', server.address().port);
  root = `http://127.0.0.1:${server.address().port}`;
  return { root, events, accountEvents, providerRevocations, fixtureErrors, requestCounts,
    advertiseProviderRevocation: value => { revocationAdvertised = value === true; },
    setProviderRevocationMode: (subject, mode) => { if(!accountSubjects.includes(subject)||!['accepted','lost-ack','unsupported'].includes(mode))throw new Error('Invalid owned revocation fixture control'); revocationModes.set(subject,mode); },
    expireAccess: subject => expiredSubjects.add(subject),
    rejectRefresh: subject => rejectedRefreshSubjects.add(subject),
    loseNextRefreshResponse: subject => lostRefreshSubjects.add(subject),
    setNextAccessLifetime: (subject, seconds) => {
      if (!accountSubjects.includes(subject) || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('Invalid owned account access lifetime');
      nextAccessLifetimes.set(subject, seconds);
    },
  };
}

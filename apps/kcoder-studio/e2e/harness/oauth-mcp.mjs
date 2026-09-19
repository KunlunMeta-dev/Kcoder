import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export async function startOAuthMcpFixture(context, { manualApproval = false, manualClient = null, resourceScopes = [], tokenResponseFields = {} } = {}) {
  const token = `opaque:${randomBytes(24).toString('hex')}|part=one.two`;
  context.registerSecret(token);
  if (manualClient?.secret) context.registerSecret(manualClient.secret);
  const grants = new Map();
  const events = [];
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
        const target = ('/approve' + url.search).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`<!doctype html><title>Owned OAuth fixture</title><a id="approve" href="${target}">Approve fixture access</a>`);
        return;
      }
      if (url.pathname === '/authorize' || url.pathname === '/approve') {
        const code = randomBytes(24).toString('hex');
        context.registerSecret(code);
        grants.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', url.searchParams.get('state'));
        callback.searchParams.set('code', code);
        response.writeHead(302, { location: callback.href, 'cache-control': 'no-store' });
        response.end();
        events.push('browser-authorize');
        return;
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
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
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, ...tokenResponseFields });
      }
      if (url.pathname !== '/mcp') return json(404, {});
      if (request.headers.authorization !== 'Bearer ' + token) {
        events.push('unauthorized');
        return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${root}/metadata"` });
      }
      const rpc = JSON.parse(body);
      events.push(rpc.method);
      if (rpc.id === undefined) {
        response.writeHead(202); response.end(); return;
      }
      const result = rpc.method === 'initialize' ? {
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' },
      } : rpc.method === 'tools/list' ? { tools: [{ name: 'oauth_probe', description: 'Owned OAuth fixture tool', inputSchema: { type: 'object', properties: {} } }] }
        : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: 'OAUTH_TOOL_OK' }] } : {};
      json(200, { jsonrpc: '2.0', id: rpc.id, result });
    })().catch(() => { response.writeHead(500); response.end('Fixture failed'); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.addCleanup('close OAuth MCP fixture', async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  context.registerPort('oauth-mcp-fixture', server.address().port);
  root = `http://127.0.0.1:${server.address().port}`;
  return { root, events };
}

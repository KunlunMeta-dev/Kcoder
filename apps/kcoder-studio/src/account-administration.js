import { spawn } from 'node:child_process';

// A separate short-lived control connection never becomes a privileged app-server stream.
export function administerAccount(spec, environment, authentication, operation, { track = value => value } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(spec.command, spec.args, { cwd: spec.cwd, env: environment, windowsHide: true,
      stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'] }));
    let output = Buffer.alloc(0);
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error('KCoder 账号管理失败：请检查管理员身份和操作参数'));
    };
    const timer = setTimeout(fail, 20000);
    timer.unref?.();
    child.stderr.resume();
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 4 * 1024 * 1024) return fail();
      output = Buffer.concat([output, chunk]);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail();
      let response;
      try { response = JSON.parse(output.toString('utf8')); }
      catch { return fail(); }
      const roleAccepted = response?.role === 'admin' ||
        (['organization.self', 'organization.export'].includes(operation?.operation) && response?.role === 'user');
      if (!response || response.protocol !== 'kcoder-account-v1' || response.authenticated !== true ||
          response.username !== authentication.username || !roleAccepted || !Object.hasOwn(response, 'result')) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(response.result);
    });
    const input = Buffer.from(JSON.stringify({ protocol: 'kcoder-account-v1', mode: 'admin', ...authentication }) + '\n' + JSON.stringify(operation) + '\n');
    child.stdin.end(input, () => input.fill(0));
  });
}

export function createAccountAdministrationRoute({ getTarget, requireSameOriginMutation, requestBody,
  requestLoginOwner, loginContexts, launchSpec, environment, track, jsonResponse }) {
  return async (request, response, pathname, authSession) => {
    const match = pathname.match(/^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/accounts$/);
    if (!match || request.method !== 'POST') return false;
    if (!requireSameOriginMutation(request)) {
      jsonResponse(response, 403, { error: 'Same-origin JSON request required' }); return true;
    }
    const target = getTarget(match[1]);
    if (!target?.security || !authSession.allowedServerIds.has(target.id)) {
      jsonResponse(response, 404, { error: 'KCoder account target is unavailable' }); return true;
    }
    try {
      const operation = JSON.parse(await requestBody(request, 4 * 1024 * 1024));
      const owner = requestLoginOwner(request, authSession);
      const principal = owner ? loginContexts.identity(owner, target.id) : null;
      const credential = owner ? loginContexts.credential(owner, target.id) : null;
      if (!principal || (principal.role !== 'admin' && !['organization.self', 'organization.export'].includes(operation?.operation)) || !credential)
        throw new Error('Account administrator required');
      const spec = launchSpec(target);
      const result = await administerAccount(spec, environment(spec), { ...credential, username: principal.username }, operation,
        { track: child => track(child, target.id) });
      jsonResponse(response, 200, { result });
    } catch {
      jsonResponse(response, 403, { error: 'KCoder 账号管理失败：请检查管理员身份和操作参数' });
    }
    return true;
  };
}

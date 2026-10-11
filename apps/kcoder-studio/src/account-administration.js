import { spawn } from 'node:child_process';

// A separate short-lived control connection never becomes a privileged app-server stream.
export function administerAccount(spec, environment, authentication, operation, { track = value => value } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(spec.command, spec.args, { cwd: spec.cwd, env: environment,
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
      if (!response || response.protocol !== 'kcoder-account-v1' || response.authenticated !== true ||
          response.username !== authentication.username || response.role !== 'admin' || !Object.hasOwn(response, 'result')) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(response.result);
    });
    const input = Buffer.from(JSON.stringify({ protocol: 'kcoder-account-v1', mode: 'admin', ...authentication }) + '\n' + JSON.stringify(operation) + '\n');
    child.stdin.end(input, () => input.fill(0));
  });
}

import { spawn } from 'node:child_process';

export function deliverNativeOidcLogout(spec, environment, token, track = value => value) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(spec.command, spec.args, { cwd: spec.cwd, env: environment, stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    let bytes = Buffer.alloc(0), settled = false;
    const fail = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); reject(new Error('OIDC logout verification failed'));
    };
    const timer = setTimeout(fail, 20000); timer.unref?.();
    child.stderr.resume(); child.on('error', fail); child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      if (bytes.length + chunk.length > 8192) { fail(); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const reply = JSON.parse(bytes.toString());
        if (code !== 0 || reply.protocol !== 'kcoder-account-v1' || reply.logoutAccepted !== true || reply.result?.processed !== true || typeof reply.result.replayed !== 'boolean') { fail(); return; }
        settled = true; clearTimeout(timer); resolve({ processed: true, replayed: reply.result.replayed });
      } catch { fail(); }
    });
    const frame = Buffer.from(JSON.stringify({ protocol: 'kcoder-account-v1', authentication: 'oidcLogout', logoutToken: token }) + '\n');
    if (frame.length > 8192) { fail(); return; }
    child.stdin.end(frame, () => frame.fill(0));
  });
}

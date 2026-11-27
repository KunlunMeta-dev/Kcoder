import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isContract } from '../../shared/generated/validator.mjs';
import { launchSpec, appServerEnvironment } from '../server-config.js';
import { peerSshDiagnosticSpec, observePeerSshAuthentication, peerSshAuthenticationSupported } from './peer-ssh-transport.mjs';

const fail = (code, unknown = false) => Object.assign(new Error(code), { code, ...(unknown ? { externalOutcome: 'unknown' } : {}) });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const actions = Object.freeze({ prepare: ['prepare', '--confirm'], observe: ['observe'],
  apply: ['apply', '--confirm', '--command-stdin'], receipt: ['read-receipt'] });

/** Preserve the selected target's original command/profile/settings/cwd. The
 * fixed management wrapper waits for the owner's input and final exit ack;
 * neither gate creates Native parent or messaging authority.
 */
export function peerSshAdminLaunch(target, workspacePath, action, operationId, ack) {
  if (!Object.hasOwn(actions, action) || target?.transport !== 'ssh' || target.security || target.remotePlatform === 'windows')
    throw fail('PEER_SSH_ADMIN_TARGET_UNSUPPORTED');
  const spec = peerSshDiagnosticSpec(launchSpec(target, { workspacePath }));
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const end = spec.args.indexOf(destination);
  if (end < 0 || spec.args.at(-1) !== 'app-server' || !/^[a-f0-9]{64}$/.test(ack)) throw fail('PEER_SSH_ADMIN_LAUNCH_INVALID');
  const native = [...spec.args.slice(end + 1, -1), 'peer-ssh', ...actions[action]];
  if (action === 'receipt') {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(operationId)) throw fail('PEER_SSH_ADMIN_OPERATION_INVALID');
    native.push('--operation-id', operationId);
  }
  const execute = native.map(quote).join(' ');
  const script = 'set -u; IFS= read -r payload || exit 74; '
    + (action === 'apply' ? `printf '%s\n' "$payload" | ${execute}` : `${execute} </dev/null`)
    + `; status=$?; printf '%s\n' '${ack}:'"$status" >&2; IFS= read -r receipt || exit 74; `
    + `[ "$receipt" = '${ack}' ] || exit 74; exit "$status"`;
  return { ...spec, args: [...spec.args.slice(0, end + 1), 'sh', '-c', quote(script)], ack };
}

export function createPeerSshAdminRunner({ trackChild, isTrackedChild, terminateChild, baseEnv = process.env,
  spawnChild = spawn, observeAuthentication = observePeerSshAuthentication, timeoutMs = 15_000 }) {
  const active = new Set(); let closed = false;
  async function run({ target, workspacePath, action, operationId, command, verifyCurrent, expectedSsh, authorizeCurrent = async () => {} }) {
    if (closed || typeof verifyCurrent !== 'function') throw fail('PEER_SSH_ADMIN_CLOSED');
    if (!peerSshAuthenticationSupported()) throw fail('PEER_SSH_ADMIN_HOST_UNSUPPORTED');
    verifyCurrent(); await authorizeCurrent(); verifyCurrent();
    if (action === 'apply' && !isContract('PeerSshPinCommandV1', command)) throw fail('PEER_SSH_ADMIN_COMMAND_INVALID');
    const input = action === 'apply' ? JSON.stringify(command) : 'observe';
    if (Buffer.byteLength(input) > 16 * 1024) throw fail('PEER_SSH_ADMIN_COMMAND_LIMIT');
    const ack = randomBytes(32).toString('hex');
    const spec = peerSshAdminLaunch(target, workspacePath, action, operationId, ack);
    const child = spawnChild(spec.command, spec.args, { cwd: spec.cwd,
      env: appServerEnvironment(baseEnv, spec.env), stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.once('error', () => {}); trackChild(child, target.id); active.add(child);
    let dispatched = false, output = Buffer.alloc(0), stderr = '', nativeStatus;
    let resolveResult, rejectResult, timer, exitTimer;
    const result = new Promise((done, reject) => { resolveResult = done; rejectResult = reject; }); result.catch(() => {});
    const receive = chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 16 * 1024 || output.indexOf(10) !== output.length - 1 && output.includes(10)) rejectResult(fail('PEER_SSH_ADMIN_OUTPUT_INVALID'));
      else if (output.includes(10)) {
        try { const text = new TextDecoder('utf-8', { fatal: true }).decode(output); resolveResult(JSON.parse(text)); }
        catch { rejectResult(fail('PEER_SSH_ADMIN_OUTPUT_INVALID')); }
      }
    };
    const diagnostics = chunk => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) { rejectResult(fail('PEER_SSH_ADMIN_DIAGNOSTICS_LIMIT')); return; }
      for (const line of stderr.split(/\r?\n/)) {
        if (line.startsWith(ack + ':') && /^\d+$/.test(line.slice(65))) {
          nativeStatus = Number(line.slice(65));
          if (nativeStatus !== 0) rejectResult(fail('PEER_SSH_ADMIN_NATIVE_REJECTED'));
        }
      }
    };
    child.stdout.on('data', receive); child.stderr.on('data', diagnostics);
    child.once('close', () => rejectResult(fail('PEER_SSH_ADMIN_TRANSPORT_CLOSED')));
    child.once('error', () => rejectResult(fail('PEER_SSH_ADMIN_TRANSPORT_FAILED')));
    let authentication;
    const ioError = () => rejectResult(fail('PEER_SSH_ADMIN_TRANSPORT_FAILED'));
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('error', ioError);
    const exited = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
    timer = setTimeout(() => rejectResult(fail('PEER_SSH_ADMIN_TIMEOUT')), timeoutMs); timer.unref?.();
    try {
      authentication = observeAuthentication({ child, target, isTrackedChild, verifyCurrent, timeoutMs });
      const ssh = await Promise.race([authentication.ready, result.then(() => { throw fail('PEER_SSH_ADMIN_EARLY_OUTPUT'); })]);
      verifyCurrent(); authentication.verify(); await authorizeCurrent(); verifyCurrent();
      if (expectedSsh && (ssh.key !== expectedSsh.sshHostKey || ssh.username !== expectedSsh.sshUser)) throw fail('PEER_SSH_ADMIN_TRANSPORT_CHANGED');
      dispatched = true; child.stdin.write(input + '\n');
      const value = await result;
      verifyCurrent(); authentication.verify(); await authorizeCurrent(); verifyCurrent();
      const schema = action === 'apply' ? 'PeerSshPinReceiptV1' : action === 'receipt' ? 'PeerSshPinReceiptReadV1' : 'PeerSshProfileObservationV1';
      if (!isContract(schema, value)) throw fail('PEER_SSH_ADMIN_OUTPUT_INVALID');
      child.stdin.end(ack + '\n');
      const exit = await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(fail('PEER_SSH_ADMIN_EXIT_UNCONFIRMED')), timeoutMs); exitTimer.unref?.(); })]);
      ssh.verifyPolicy(); ssh.requireExited(); verifyCurrent(); await authorizeCurrent(); verifyCurrent();
      if (exit.code !== 0 || exit.signal || nativeStatus !== 0) throw fail('PEER_SSH_ADMIN_EXIT_UNCONFIRMED');
      return { value, ssh: { sshHostKey: ssh.key, sshUser: ssh.username } };
    } catch (error) {
      if (dispatched && ['apply', 'prepare'].includes(action)) throw fail('PEER_SSH_ADMIN_OUTCOME_UNKNOWN', true);
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(exitTimer); child.stdout.off('data', receive); child.stderr.off('data', diagnostics);
      await terminateChild(child); authentication?.close(); active.delete(child);
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.off('error', ioError);
    }
  }
  return Object.freeze({ run, supported: peerSshAuthenticationSupported,
    async close() { closed = true; await Promise.allSettled([...active].map(child => terminateChild(child))); } });
}

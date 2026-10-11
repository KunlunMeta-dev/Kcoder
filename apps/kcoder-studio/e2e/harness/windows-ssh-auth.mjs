const registered = new WeakMap();
// Password auth is opt-in for an explicitly authorized physical Windows host.
// Keep secrets in child environment only; never in argv, files, or manifests.
export function windowsSshInvocation(context, command, args, target, password = process.env.KCODER_E2E_WINDOWS_SSH_PASSWORD) {
  if (!password) return { command, args, options: {} };
  if (!['ssh', 'scp'].includes(command) || !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target || ''))
    throw new Error('Invalid password-authenticated Windows transport');
  if (!args.some(value => value === target || value.startsWith(`${target}:`)))
    throw new Error('Windows password transport requires its explicit target');
  let known = registered.get(context);
  if (!known) { known = new Map(); registered.set(context, known); }
  if (!known.has(password)) {
    context.registerSecret(password);
    known.set(password, context.isolatedEnvironment({ SSHPASS: password }));
  }
  return {
    command: 'sshpass',
    args: ['-e', command, ...args.map(value => value === 'BatchMode=yes' ? 'BatchMode=no' : value)],
    options: { env: { ...known.get(password) } },
  };
}

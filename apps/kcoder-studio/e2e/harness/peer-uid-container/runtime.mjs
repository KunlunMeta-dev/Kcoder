import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { waitFor } from '../run-context.mjs';
import { waitForStdioChildClose } from '../app-server-stdio.mjs';
import { createPeerUidDockerConnection, observeOwnedPeerUidImage } from './image.mjs';
import { capturePeerUidContainer, containerLabel, removeStoppedPeerUidContainer, stopOriginalPeerUidContainer } from './container.mjs';
import { pinPeerUidNative } from './native-input.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export async function startPeerUidNamespace(context, { product } = {}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(process.env[product ? 'KCODER_E2E_PEER_UID_CONTAINER_PRODUCT' : 'KCODER_E2E_PEER_UID_CONTAINER_PREFLIGHT'], '1', 'Explicit original two-UID fixture gate required');
  const receiptPath = process.env.KCODER_E2E_PEER_UID_CONTAINER_IMAGE_RECEIPT;
  assert.ok(typeof receiptPath === 'string' && receiptPath.startsWith('/'));
  const info = await lstat(receiptPath); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 128 * 1024);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const execute = await createPeerUidDockerConnection(context);
  await observeOwnedPeerUidImage(context, receipt, execute);
  const owner = randomUUID(), name = `kcoder-peer-uids-${owner}`;
  const control = context.pathInState('container-control'), homeA = context.pathInState('home-a'), homeB = context.pathInState('home-b');
  for (const path of [control, homeA, homeB]) await mkdir(path, { mode: 0o700 });
  await writeFile(resolve(control, 'owner.json'), JSON.stringify({ owner }), { mode: 0o600, flag: 'wx' });
  const clientKey = context.pathInState('client-key');
  const keygen = context.spawnOwned('peer-uid-client-keygen', '/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'owned-peer-uid-precheck', '-f', clientKey], { env: context.isolatedEnvironment(), stdin: 'ignore' });
  assert.equal((await waitForStdioChildClose(keygen, 10000, 'owned client key')).code, 0);
  context.registerSecret(await readFile(clientKey, 'utf8'));
  const publicKey = clientKey + '.pub', controller = resolve(directory, 'controller.py');
  const mounts = [
    { source: controller, destination: '/fixture/controller.py', writable: false },
    { source: publicKey, destination: '/auth/authorized_keys', writable: false },
    { source: control, destination: '/control', writable: true },
    { source: homeA, destination: '/home/a', writable: true },
    { source: homeB, destination: '/home/b', writable: true },
  ];
  let nativeInputs;
  if (product) {
    nativeInputs = { program: await pinPeerUidNative(product.binary, product.binarySha256), supervisor: await pinPeerUidNative(product.supervisor, product.supervisorSha256) };
    const nativeBin = context.pathInState('peer-uid-native-bin'); await mkdir(nativeBin);
    for (const [name, pin] of [['kcoder', nativeInputs.program], ['kcoder-process-supervisor', nativeInputs.supervisor]]) {
      const copy = resolve(nativeBin, name); await copyFile(pin.path, copy); await access(copy, constants.X_OK); await pinPeerUidNative(copy, pin.sha256);
    }
    mounts.push({ source: nativeBin, destination: '/runtime', writable: false });
  }
  let handle, expectedContainer, attached, closed, ready, removed = false;
  const close = async () => {
    if (removed) return;
    if (!handle && expectedContainer) handle = await capturePeerUidContainer(context, expectedContainer, execute);
    if (!handle) return;
    if (attached && attached.exitCode === null) {
      attached.stdin.end(JSON.stringify({ operation: 'finish' }) + '\n');
      const exit = await waitForStdioChildClose(attached, 20000, 'original namespace controller');
      assert.equal(exit.code, 0, 'Retain original namespace data until cleanup is confirmed');
      assert.ok(closed?.closed === true && closed.owner === owner && closed.originalAccountsRetired && closed.originalSshdExited && closed.originalUidProcessesAbsent);
    } else if (ready) {
      assert.ok(closed?.closed === true, 'Retain unexpected namespace termination');
    }
    await stopOriginalPeerUidContainer(context, handle);
    await removeStoppedPeerUidContainer(context, handle); removed = true;
    await context.writeArtifactJsonInternal('peer-uid-container-closed.json', { ...closed, originalContainerRemoved: true });
  };
  context.addCleanup('close and remove only original two-UID namespace', close, { timeoutMs: 30000 });
  const arguments_ = ['create', '--interactive', '--name', name, '--label', `${containerLabel}=${owner}`, '--network', 'none', '--pids-limit', product ? '256' : '64', '--memory', product ? '1g' : '512m', '--cpus', product ? '2' : '1', '--cap-drop', 'ALL'];
  for (const capability of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'SYS_CHROOT', 'AUDIT_WRITE', ...(product ? ['SYS_PTRACE'] : [])]) arguments_.push('--cap-add', capability);
  arguments_.push('--security-opt', 'no-new-privileges:true');
  for (const mount of mounts) arguments_.push('--mount', `type=bind,src=${mount.source},dst=${mount.destination}${mount.writable ? '' : ',readonly'}`);
  arguments_.push(receipt.imageId, '/fixture/controller.py', product ? 'product' : 'daemon', owner);
  const id = (await execute(arguments_, { label: 'create-owned-container' })).trim(); assert.match(id, /^[a-f0-9]{64}$/);
  expectedContainer = { id, image: receipt.imageId, owner, mounts };
  await context.writeArtifactJson('peer-uid-container-owner.json', { id, image: receipt.imageId, owner, name, mounts });
  handle = await capturePeerUidContainer(context, expectedContainer, execute);
  attached = await execute.launch(['start', '--attach', '--interactive', id], { label: 'original-container-controller', stdin: 'pipe' });
  // LIFO: finish PID1 before RunContext stops its attached Docker client.
  context.addCleanup('finish original namespace before stopping its attachment', close, { timeoutMs: 30000 });
  const reader = createInterface({ input: attached.stdout }); let frameFailure, requestSequence = 0;
  const replies = new Map();
  reader.on('line', line => { try { const frame = JSON.parse(line); assert.equal(frame.owner, owner); if (frame.ready === true && !ready) ready = frame; else if (typeof frame.closed === 'boolean' && !closed) closed = frame; else if (frame.snapshot === true && replies.has(frame.requestId)) { replies.get(frame.requestId)(frame); replies.delete(frame.requestId); } else throw Error('Unexpected namespace frame'); } catch (error) { frameFailure ??= error; } });
  await waitFor(() => { if (frameFailure) throw frameFailure; if (attached.exitCode !== null) throw Error('Namespace controller exited before ready'); return ready; }, 15000, 'original namespace sshd ready');
  assert.equal(ready.users.length, 2); assert.notEqual(ready.users[0].uid, ready.users[1].uid);
  for (const user of ready.users) assert.ok(user.uid >= 1000 && user.gid > 0);
  const knownHosts = context.pathInState('known-hosts');
  await writeFile(knownHosts, `[127.0.0.1]:${ready.port} ${ready.hostKey.split(/\s+/).slice(0, 2).join(' ')}\n`, { mode: 0o600, flag: 'wx' });
  const proxy = await context.writeStateJson('proxy.json', { id, image: receipt.imageId, owner, port: ready.port, dockerConfig: execute.configuration });
  const proxyCommand = [process.execPath, resolve(directory, 'ssh-byte-proxy.mjs'), proxy].map(quote).join(' ');
  const bin = context.pathInState('ssh-bin'); await mkdir(bin, { mode: 0o700 });
  await writeFile(resolve(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -i ${quote(clientKey)} -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(knownHosts)} -o ProxyCommand=${quote(proxyCommand)} "$@"\n`, { mode: 0o700, flag: 'wx' });
  const probeUsers = async () => {
    const observations = [];
    for (let index = 0; index < ready.users.length; index++) {
    const user = ready.users[index], other = ready.users[1 - index];
    const args = ['-F', '/dev/null', '-T', '-i', clientKey, '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', `ProxyCommand=${proxyCommand}`, '-o', 'LogLevel=DEBUG1', '-p', String(ready.port), `${user.name}@127.0.0.1`, '/usr/bin/python3', '-I', '-S', '-B', '/fixture/controller.py', 'probe', other.home];
    const child = context.spawnOwned(`peer-uid-actual-ssh-${index}`, '/usr/bin/ssh', args, { env: context.isolatedEnvironment({ SSH_AUTH_SOCK: '' }), stdin: 'ignore' });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length < 32768); }); child.stderr.on('data', bytes => { stderr += bytes; });
    const exit = await waitForStdioChildClose(child, 20000, `actual UID ${index} SSH`); assert.equal(exit.code, 0, 'Actual original SSH authentication/probe failed');
    assert.ok(stderr.includes(`as '${user.name}'`) && /Authenticated to .+using "publickey"/.test(stderr), 'Actual OpenSSH transport authentication facts required');
    const actual = JSON.parse(stdout); assert.equal(actual.uid, user.uid); assert.equal(actual.euid, user.uid); assert.equal(actual.gid, user.gid); assert.equal(actual.username, user.name);
    assert.equal(actual.home, user.home); assert.equal(actual.passwdHome, user.home); assert.equal(actual.ownMarkerReadable, true); assert.equal(actual.otherHomeReadBlocked, true);
    assert.equal(actual.pythonWritable, false); assert.equal(actual.sshdWritable, false); assert.equal(actual.noNewPrivs, '1'); assert.ok(!actual.groups.includes(0));
      if (product) assert.equal(actual.nativeWritable, false);
      observations.push(actual);
    }
    await context.writeArtifactJson('peer-uid-ssh-precheck.json', { id, image: receipt.imageId, owner, users: observations, actualOpenSshAuthentication: true, hostAccountChanges: 0, candidateMounted: Boolean(product), network: 'none', hostConfigLoaded: false, hostSshAgentUsed: false });
    return observations;
  };
  const snapshot = async nativePids => {
    const requestId = ++requestSequence;
    const pending = new Promise(resolveReply => replies.set(requestId, resolveReply));
    attached.stdin.write(JSON.stringify({ operation: 'snapshot', requestId, nativePids }) + '\n');
    let timer;
    try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Original UID snapshot timed out')), 10000); })]); }
    finally { clearTimeout(timer); replies.delete(requestId); }
  };
  return { id, owner, users: ready.users, port: ready.port, nativeInputs, probeUsers, snapshot,
    sshEnvironment: { PATH: `${bin}:/usr/bin:/bin`, SSH_AUTH_SOCK: '' },
    async close() { await close(); reader.close(); return closed; },
  };
}

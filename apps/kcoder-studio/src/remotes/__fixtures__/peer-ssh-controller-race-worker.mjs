// Owned Node unit workload: real shared private journal, deterministic Native
// responses and no SSH/model/platform acceptance claim.
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPeerSshEnrollmentGateway } from '../peer-ssh-enrollment-gateway.mjs';
import { createPeerSshPinStore } from '../peer-ssh-pin-store.mjs';
import { peerSshFactsFixture } from './peer-ssh-facts.mjs';

const root = process.argv[2], emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const releases = new Map(); let active;
const wait = async (name, id) => {
  const key = `${name}:${id}`; let release;
  const promise = new Promise(done => { release = done; }); releases.set(key, release);
  emit({ event: name, id }); await promise; releases.delete(key);
};
const target = { id: 'owned-ssh', runtime: 'kcoder', transport: 'ssh', host: 'owned.example', user: 'owned-peer', command: '/owned/kcoder', remoteCwd: '/owned/workspace' };
const session = { browserAdmin: true, allowedServerIds: new Set([target.id]) };
const store = createPeerSshPinStore({ directory: root });
const runner = { async run(options) {
  options.verifyCurrent(); await options.authorizeCurrent();
  if (['prepare', 'observe'].includes(options.action)) {
    if (active.holdPrepare) await wait('prepare_wait', active.id);
    return { value: { version: 1, native: peerSshFactsFixture().enrollment.native, pinRevision: 0 }, ssh: { sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: target.user } };
  }
  if (options.action === 'receipt') return { value: { version: 1, operationId: options.operationId, receipt: null } };
  if (active.holdNative) await wait('native_wait', active.id);
  await options.authorizeCurrent(); options.verifyCurrent();
  await appendFile(join(root, 'native-effects.log'), options.command.operationId + '\n');
  return { value: { version: 1, operationId: options.command.operationId,
    enrollmentId: options.command.action.enrollment.enrollmentId, revision: options.command.expectedRevision + 1,
    generation: options.command.action.enrollment.generation, status: 'pinned' } };
}, async close() { for (const release of releases.values()) release(); } };
const gateway = createPeerSshEnrollmentGateway({ directory: root, getTarget: id => id === target.id ? target : null,
  targetSignature: JSON.stringify, loginContexts: { identity: () => null, generation: () => 1 },
  authorize: async () => session, sameOrigin: () => true,
  requestBody: async request => { if (request.holdBody) await wait('body_wait', request.id); return JSON.stringify(request.body); },
  jsonResponse: (response, status, body) => Object.assign(response, { status, body }), store, runner });
const input = createInterface({ input: process.stdin });
let closing;
const close = () => closing ??= (async () => { await gateway.close(); input.close(); process.exitCode = 0; })();
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.release) { releases.get(command.release)?.(); return; }
  if (command.close) { void close(); return; }
  active = command;
  void (async () => {
    const response = {};
    await gateway.handle({ method: 'POST', headers: {}, ...command,
      body: { workspacePath: target.remoteCwd, ...(command.body ?? {}) } }, response,
    `/api/servers/${target.id}/peer-ssh/${command.action}`);
    emit({ id: command.id, ...response });
  })().catch(error => emit({ id: command.id, workerError: error.code ?? error.message }));
});
input.on('close', () => { void close(); });
emit({ event: 'ready', pid: process.pid });

import { observeNativeRemoteHostStage } from './host-backchannel.mjs';
import { spawn } from 'node:child_process';
import { captureOwnedNativeSshAcpTransport } from './owned-ssh-acp-transport.mjs';
import { pinnedNativeSshLaunch, pinnedNativeSshReadLaunch } from './pinned-ssh-launch.mjs';
import { requireCapturedNativeRemoteSourceClient } from './source-client-owner.mjs';

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value);
const fail = () => { throw new Error('REMOTE_HOST_ORIGINAL_ENDPOINT_REQUIRED'); };
const SSH_ENVIRONMENT = new Set(['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'KRB5CCNAME']);
const sshEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => SSH_ENVIRONMENT.has(name.toUpperCase())));

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let finished = false;
    let grace;
    let force;
    const done = () => { if (!finished) { finished = true; clearTimeout(grace); clearTimeout(force); resolve(); } };
    child.once('close', done);
    try { child.stdin.end(); } catch { /* Only this captured child is owned. */ }
    grace = setTimeout(() => {
      if (!finished) child.kill();
      force = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 1000);
      force.unref?.();
    }, 500);
    grace.unref?.();
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}

function waitForImageGate(child, ready, signal, deadlineAtMs, verify) {
  return new Promise((resolve, reject) => {
    let partial = Buffer.alloc(0);
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      child.removeListener('error', closed);
      child.removeListener('close', closed);
      child.stdout.removeListener('data', receive);
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(new Error('REMOTE_HOST_SOURCE_CLOSED'));
    const closed = () => finish(new Error('REMOTE_HOST_IMAGE_GATE_UNCONFIRMED'));
    const receive = chunk => {
      try { verify(); } catch { closed(); return; }
      partial = Buffer.concat([partial, Buffer.from(chunk)]);
      const end = partial.indexOf(0x0a);
      if ((end < 0 && partial.length > 256) || end > 256) { closed(); return; }
      if (end < 0) return;
      if (partial.subarray(0, end).toString('utf8').replace(/\r$/, '') !== ready) { closed(); return; }
      child.stdout.pause();
      const remainder = partial.subarray(end + 1);
      finish();
      if (remainder.length) child.stdout.unshift(remainder);
    };
    const timer = setTimeout(closed, Math.max(1, Math.min(10000, deadlineAtMs - Date.now())));
    timer.unref?.();
    child.once('error', closed);
    child.once('close', closed);
    child.stdout.on('data', receive);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

function readOriginalFrame(child, original, signal, deadlineAtMs, verify) {
  return new Promise((resolve, reject) => {
    let partial = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      child.removeListener('close', closed);
      child.removeListener('error', closed);
      child.stdin.removeListener('error', closed);
      child.stdout.removeListener('data', receive);
      error ? reject(error) : resolve(value);
    };
    const closed = () => finish(new Error('REMOTE_HOST_ORIGINAL_READ_UNCONFIRMED'));
    const cancelled = () => finish(new Error('REMOTE_HOST_SOURCE_CLOSED'));
    const receive = chunk => {
      try {
        verify();
        partial = Buffer.concat([partial, Buffer.from(chunk)]);
        if (partial.length > 32 * 1024) return closed();
        const end = partial.indexOf(0x0a);
        if (end < 0) return;
        if (end !== partial.length - 1) return closed();
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(partial.subarray(0, end)));
        if (!value || Array.isArray(value) || value.original?.operationId !== original.operationId
            || value.original?.requestId !== original.requestId) return closed();
        verify();
        finish(null, value);
      } catch { closed(); }
    };
    const timer = setTimeout(closed, Math.max(1, deadlineAtMs - Date.now()));
    timer.unref?.();
    child.once('close', closed);
    child.once('error', closed);
    child.stdin.once('error', closed);
    child.stdout.on('data', receive);
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      verify();
      if (signal.aborted) return cancelled();
      const frame = Buffer.from(JSON.stringify(original) + '\n');
      if (frame.length > 32 * 1024) return closed();
      child.stdin.end(frame);
      child.stdout.resume();
    } catch { closed(); }
  });
}

/** Private Gateway provider. Only the composition root supplies the actual
 * held Source child and authenticated socket resolver. JSON cannot install it.
 * This owns SSH bytes and image pinning; it supplies no Receiver Accepted,
 * execution permission, model authority or remote cleanup confirmation.
 */
export function createNativeSshEndpointFactory({ assertSourceNativeChild, sourceClientForAttempt, sourceClientForManagement,
  spawnChild = spawn, stopChild = stopOwnedChild, diagnosticSink }) {
  if (typeof assertSourceNativeChild !== 'function' || typeof sourceClientForAttempt !== 'function') fail();
  const endpoints = new Map();
  const readers = new Set();
  let closed = false;
  const keyFor = params => {
    if (!params || !identifier(params.operationId) || !identifier(params.endpointInstanceId)) fail();
    return JSON.stringify([params.operationId, params.endpointInstanceId]);
  };
  const base = (context, record) => {
    if (closed || record.child !== context.child || record.serverId !== context.serverId
        || JSON.stringify(context.params?.sourceAttempt) !== record.sourceAttempt
        || context.params?.sourceAcceptedSha256 !== record.sourceAcceptedSha256) fail();
    assertSourceNativeChild({ child: context.child, serverId: context.serverId });
    record.verify();
  };
  const closeRecord = async record => {
    record.controller.abort();
    await record.opening?.catch(() => {});
    if (record.transport) await record.transport.close();
    else if (record.sshChild) await stopChild(record.sshChild);
    return { operationId: record.operationId, endpointInstanceId: record.endpointInstanceId,
      state: 'closed', transportCleanupConfirmed: Boolean(record.sshChild &&
        (record.sshChild.exitCode !== null || record.sshChild.signalCode !== null)), nativeOwnerCleanupConfirmed: false };
  };
  return Object.freeze({
    async handleOwnedRequest(context) {
      const { child, serverId, method, params, signal } = context;
      if (method === 'server/nativeRemote/readOriginal') {
        if (closed || readers.size >= 8 || typeof sourceClientForManagement !== 'function'
            || !params?.original || !identifier(params.original.operationId)
            || !identifier(params.original.endpointInstanceId)
            || !Number.isSafeInteger(params.deadlineUtcMs) || params.deadlineUtcMs <= Date.now()
            || params.deadlineUtcMs > Date.now() + 30000) fail();
        assertSourceNativeChild({ child, serverId });
        const source = requireCapturedNativeRemoteSourceClient(sourceClientForManagement(params));
        const controller = new AbortController();
        let finished;
        const readerOwner = { controller, done: new Promise(resolve => { finished = resolve; }) };
        readers.add(readerOwner);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) controller.abort();
        try {
          return await source.withAuthorizedTarget(params.target, async ({ target, verify }) => {
            const check = () => {
              verify(); assertSourceNativeChild({ child, serverId });
              if (closed || controller.signal.aborted) fail();
            };
            check();
            const existing = endpoints.get(JSON.stringify([params.original.operationId, params.original.endpointInstanceId]));
            if (existing?.child === child && existing.serverId === serverId
                && existing.transport && !existing.transport.closed) {
              // An active original channel keeps producing its own receipts.
              // Management polling cannot open a second SSH execution stream.
              return { original: params.original, outcome: null, finishedAtMs: null };
            }
            const spec = pinnedNativeSshReadLaunch(target, params.target);
            check();
            const reader = spawnChild(spec.command, spec.args, { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let stderrBytes = 0;
            reader.stderr.on('data', chunk => {
              stderrBytes += Buffer.byteLength(chunk);
              if (stderrBytes > 64 * 1024) controller.abort();
            });
            try {
              await waitForImageGate(reader, spec.ready, controller.signal, params.deadlineUtcMs, check);
              check();
              const reply = await readOriginalFrame(reader, params.original, controller.signal, params.deadlineUtcMs, check);
              check();
              return reply;
            } finally { await stopChild(reader); }
          });
        } finally {
          signal?.removeEventListener('abort', abort);
          readers.delete(readerOwner);
          finished();
        }
      }
      const key = keyFor(params);
      if (method === 'server/nativeRemote/open') {
        let stage = 'open_validation';
        try {
          if (closed || endpoints.has(key) || endpoints.size >= 64 || !params.target
              || !/^[a-f0-9]{64}$/.test(params.sourceAcceptedSha256)
              || !Number.isSafeInteger(params.deadlineUtcMs) || params.deadlineUtcMs <= Date.now()
              || params.deadlineUtcMs > Date.now() + 86400000) fail();
          stage = 'source_child_owner';
          assertSourceNativeChild({ child, serverId });
          stage = 'source_socket_owner';
          const sourceClient = requireCapturedNativeRemoteSourceClient(sourceClientForAttempt(params.sourceAttempt));
          const controller = new AbortController();
          const record = { child, serverId, operationId: params.operationId, endpointInstanceId: params.endpointInstanceId,
            sourceAttempt: JSON.stringify(params.sourceAttempt), sourceAcceptedSha256: params.sourceAcceptedSha256,
            controller, verify: () => { sourceClient.verify(); assertSourceNativeChild({ child, serverId }); } };
          // Save before spawn. Unknown opening cannot be retried with this identity.
          endpoints.set(key, record);
          const abort = () => { void closeRecord(record).catch(() => {}); };
          signal?.addEventListener('abort', abort, { once: true });
          stage = 'selected_target_owner';
          record.opening = sourceClient.withAuthorizedTarget(params.target, async ({ target, verify }) => {
            stage = 'pinned_launch_spec';
            const spec = pinnedNativeSshLaunch(target, params.target);
            record.receiverWorkspace = target.remoteCwd;
            record.targetPlatform = spec.platform;
            record.nativeSha256 = params.target.expectedNativeSha256;
            record.verify = () => { verify(); assertSourceNativeChild({ child, serverId }); };
            record.verify();
            if (signal?.aborted || controller.signal.aborted) fail();
            stage = 'ssh_spawn';
            const sshChild = spawnChild(spec.command, spec.args, { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            record.sshChild = sshChild;
            let stderrBytes = 0;
            sshChild.stderr.on('data', chunk => {
              stderrBytes += Buffer.byteLength(chunk);
              if (stderrBytes > 64 * 1024) controller.abort();
            });
            try {
              stage = 'ssh_image_gate';
              await waitForImageGate(sshChild, spec.ready, controller.signal, params.deadlineUtcMs, record.verify);
              record.verify();
              record.transport = captureOwnedNativeSshAcpTransport({ child: sshChild,
                assertEndpointOwner: record.verify, stopOwned: () => stopChild(sshChild),
                operationId: params.operationId, endpointInstanceId: params.endpointInstanceId,
                deadlineAtMs: params.deadlineUtcMs, signal: controller.signal });
              sshChild.stdout.resume();
              return record.transport;
            } catch (cause) {
              controller.abort();
              await stopChild(sshChild);
              throw new Error('REMOTE_HOST_OPEN_UNCONFIRMED_RECONCILE_ORIGINAL', { cause });
            }
          });
          try {
            await record.opening;
            stage = 'opened_owner';
            base(context, record);
            return { operationId: params.operationId, endpointInstanceId: params.endpointInstanceId, state: 'opened',
              receiverWorkspace: record.receiverWorkspace, targetPlatform: record.targetPlatform, nativeSha256: record.nativeSha256 };
          } catch (cause) {
            controller.abort();
            throw new Error('REMOTE_HOST_OPEN_UNCONFIRMED_RECONCILE_ORIGINAL', { cause });
          }
        } catch (error) {
          observeNativeRemoteHostStage(stage, error, diagnosticSink);
          throw error;
        }
      }
      const record = endpoints.get(key);
      if (!record || record.child !== child || record.serverId !== serverId) fail();
      if (method === 'server/nativeRemote/close') return closeRecord(record);
      base(context, record);
      if (method === 'server/nativeRemote/exchange' && params.direction === 'owner_observe') {
        return { operationId: record.operationId, endpointInstanceId: record.endpointInstanceId, state: 'owner_observed' };
      }
      const transport = await record.opening;
      if (method !== 'server/nativeRemote/exchange') fail();
      if (params.direction === 'frame_write') {
        if (!Number.isSafeInteger(params.sequence) || params.sequence <= 0) fail();
        const receipt = await transport.writeOnce(`frame-${params.sequence}`, params.frame);
        base(context, record);
        return { ...receipt, sequence: params.sequence };
      }
      if (params.direction === 'frame_read') {
        const result = await transport.read({ acknowledgeThrough: params.acknowledgeThrough,
          maximumFrames: params.maximumFrames, waitMs: params.waitMs });
        base(context, record);
        return result;
      }
      fail();
    },
    async close() {
      closed = true;
      const remainingReaders = [...readers];
      for (const reader of remainingReaders) reader.controller.abort();
      await Promise.allSettled([...endpoints.values()].map(closeRecord).concat(remainingReaders.map(reader => reader.done)));
    },
  });
}

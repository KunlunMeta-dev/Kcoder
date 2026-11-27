// Fault only the actual owned SSH response stream. No Source port, permission,
// task, control receipt or replacement transport is installed by this fixture.
import childProcesses from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_FRAME = 2 * 1024 * 1024;
const controlled = process.env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT === '1';
const directory = process.env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT_DIRECTORY;
const kind = process.env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT_KIND || 'completion';

export function inspectOwnedRemoteFrame(frame, state) {
  if (frame?.jsonrpc !== '2.0') return false;
  if (frame.method === 'session/prompt' && frame.id !== undefined) state.promptId = frame.id;
  if (frame.method === 'kcoder/nativeRemote/controlV1') {
    const params = frame.params;
    if (params?.message?.method === 'bind_original') {
      state.operationId = params.operationId;
      state.endpointInstanceId = params.endpointInstanceId;
    }
    if (params?.message?.method === 'receiver_accepted') state.accepted = params.message.params;
    if (params?.message?.method === 'read_artifact_manifest') state.artifactManifestId = frame.id;
    if (params?.message?.method === 'read_artifact_chunk') {
      state.artifactChunkId = frame.id;
      state.artifactChunkIntent = params.message.params;
    }
  }
  if (state.kind === 'artifact_chunk') {
    if (frame.id === state.artifactManifestId && frame.result?.data?.kind === 'artifact_manifest')
      state.originalArtifactManifest = frame.result.data.manifest;
    return state.artifactChunkId !== undefined && frame.id === state.artifactChunkId
      && frame.error === undefined && frame.result?.data?.kind === 'artifact_chunk'
      && frame.result.operationId === state.operationId
      && frame.result.endpointInstanceId === state.endpointInstanceId
      && frame.result.data.manifestSha256 === state.artifactChunkIntent?.manifestSha256;
  }
  return state.promptId !== undefined && frame.id === state.promptId && frame.result !== undefined && frame.error === undefined;
}

export function partialArtifactChunkPrefix(line) {
  const marker = Buffer.from('"bytesBase64":"');
  const start = line.indexOf(marker);
  if (start < 0) throw new Error('Actual artifact chunk bytes required');
  const bytesStart = start + marker.length;
  const end = line.indexOf(0x22, bytesStart);
  if (end - bytesStart < 8) throw new Error('Actual nonempty artifact chunk required');
  const cut = bytesStart + Math.max(4, Math.floor((end - bytesStart) / 8) * 4);
  if (cut >= end || cut >= line.length - 1) throw new Error('Partial original artifact bytes required');
  return line.subarray(0, cut);
}

if (controlled) {
  if (!['completion', 'artifact_chunk'].includes(kind)) throw new Error('Known owned remote fault required');
  if (!directory) throw new Error('Owned remote disconnect evidence directory required');
  const actualSpawn = childProcesses.spawn;
  let captured = false;
  childProcesses.spawn = function (command, args, options) {
    const child = actualSpawn.call(this, command, args, options);
    if (captured || basename(String(command)) !== 'ssh' || !Array.isArray(args)
      || !args.some(value => String(value).includes('kcoder-native-acp-image-v1:'))) return child;
    captured = true;
    const state = { kind, actualOwnedChildPid: child.pid, forwarded: 0, held: false };
    const record = () => writeFileSync(join(directory, 'remote-transport-disconnect.json'), JSON.stringify(state), { mode: 0o600 });
    let sentPartial = Buffer.alloc(0);
    const write = child.stdin.write;
    child.stdin.write = function (input, ...rest) {
      sentPartial = Buffer.concat([sentPartial, Buffer.isBuffer(input) ? input : Buffer.from(input)]);
      for (let end = sentPartial.indexOf(10); end >= 0; end = sentPartial.indexOf(10)) {
        const bytes = sentPartial.subarray(0, end); sentPartial = sentPartial.subarray(end + 1);
        try { inspectOwnedRemoteFrame(JSON.parse(bytes.toString('utf8')), state); } catch { /* The production parser owns invalid bytes. */ }
      }
      if (sentPartial.length > MAX_FRAME) sentPartial = Buffer.alloc(0);
      return write.call(this, input, ...rest);
    };
    let partial = Buffer.alloc(0);
    const emit = child.stdout.emit;
    let heldBytes;
    let timer;
    child.once('close', () => { clearInterval(timer); state.actualChildClosed = true; record(); });
    child.stdout.emit = function (event, chunk, ...rest) {
      // Image-pin gate bytes and initialization pass unchanged before the
      // original prompt is written; pausing/unshift semantics stay production-owned.
      if (event !== 'data' || state.promptId === undefined) return emit.call(this, event, chunk, ...rest);
      if (state.held) return true;
      partial = Buffer.concat([partial, Buffer.from(chunk)]);
      if (partial.length > MAX_FRAME) {
        const original = partial; partial = Buffer.alloc(0);
        return emit.call(this, event, original, ...rest);
      }
      for (let end = partial.indexOf(10); end >= 0; end = partial.indexOf(10)) {
        const line = partial.subarray(0, end + 1); partial = partial.subarray(end + 1);
        let frame;
        try { frame = JSON.parse(line.toString('utf8')); } catch { /* Forward exact bytes. */ }
        if (inspectOwnedRemoteFrame(frame, state)) {
          state.held = true;
          state.replyWasForwarded = false;
          state.originalReplyBytes = line.length;
          state.originalStopReason = frame.result?.stopReason ?? null;
          heldBytes = line; // Original bytes are never substituted.
          if (kind === 'artifact_chunk') {
            const prefix = partialArtifactChunkPrefix(line);
            state.partialReplyBytesForwarded = prefix.length;
            state.withheldReplyBytes = line.length - prefix.length;
            emit.call(this, event, prefix, ...rest);
          }
          record();
          timer = setInterval(() => {
            let plan;
            try { plan = JSON.parse(readFileSync(join(directory, 'remote-disconnect-plan.json'), 'utf8')); } catch { return; }
            if (plan.operationId !== state.operationId || plan.endpointInstanceId !== state.endpointInstanceId || plan.disconnect !== true) return;
            clearInterval(timer);
            state.disconnectedBeforeOriginalReply = true;
            state.heldOriginalBytesDiscarded = heldBytes.length;
            heldBytes = undefined;
            record();
            // Only this captured actual Child is signalled. Product-owned
            // transport shutdown must settle its own remote subtree/uncertainty.
            child.kill('SIGTERM');
          }, 10);
          timer.unref();
          return true;
        }
        state.forwarded++;
        emit.call(this, event, line, ...rest);
      }
      return true;
    };
    return child;
  };
  syncBuiltinESMExports();
}

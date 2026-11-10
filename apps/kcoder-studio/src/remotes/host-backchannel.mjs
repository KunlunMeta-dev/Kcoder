export const NATIVE_REMOTE_HOST_PREFIX = 'server/nativeRemote/';
export const NATIVE_REMOTE_HOST_REQUEST_PREFIX = 'native-remote-host-';
const DIAGNOSTIC_STAGES = new Set(['open_received', 'backchannel_source_owner', 'backchannel_owned_request',
  'backchannel_receipt_owner', 'open_validation', 'source_child_owner', 'source_socket_owner',
  'selected_target_owner', 'pinned_launch_spec', 'ssh_spawn', 'ssh_image_gate', 'opened_owner']);
const DIAGNOSTIC_CODES = new Set(['REMOTE_HOST_SOURCE_OWNER_CHANGED', 'REMOTE_HOST_SOURCE_CLIENT_CHANGED',
  'REMOTE_HOST_ORIGINAL_ENDPOINT_REQUIRED', 'REMOTE_HOST_NATIVE_SSH_TARGET_UNAVAILABLE',
  'REMOTE_HOST_ABSOLUTE_NATIVE_IMAGE_REQUIRED', 'REMOTE_HOST_INVALID_NATIVE_PROFILE',
  'REMOTE_HOST_INVALID_SSH_PORT', 'REMOTE_HOST_SOURCE_CLOSED', 'REMOTE_HOST_IMAGE_GATE_UNCONFIRMED',
  'REMOTE_HOST_OPEN_UNCONFIRMED_RECONCILE_ORIGINAL']);

// Only fixed stage names and a closed code set enter diagnostics; never raw
// errors, request params, paths, authentication material or nested messages.
export function observeNativeRemoteHostStage(stage, error, sink = value => process.stderr.write(JSON.stringify(value) + '\n')) {
  let code = error ? 'REMOTE_HOST_UNCLASSIFIED' : null;
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    if (DIAGNOSTIC_CODES.has(current.message)) code = current.message;
  }
  try { sink({ event: 'native-remote-host', stage: DIAGNOSTIC_STAGES.has(stage) ? stage : 'unclassified_stage', state: error ? 'rejected' : 'observed', code }); }
  catch { /* Diagnostics cannot change the original operation outcome. */ }
}

const METHODS = new Set(['open', 'exchange', 'close', 'readOriginal'].map(name => NATIVE_REMOTE_HOST_PREFIX + name));

export function isNativeRemoteHostMethod(method) {
  return typeof method === 'string' && method.startsWith(NATIVE_REMOTE_HOST_PREFIX);
}

export function isNativeRemoteHostRequestId(id) {
  return typeof id === 'string' && id.startsWith(NATIVE_REMOTE_HOST_REQUEST_PREFIX);
}

function validId(id) {
  return Number.isSafeInteger(id) || (typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id));
}

/** Routing only. Root supplies the actual captured Source child/parent owner;
 * callbacks cannot be reconstructed from a request, target name or JSON marker.
 * The handler owns the original deadline, receipts and specific SSH resources.
 */
export function createNativeRemoteHostBackchannel({ child, serverId, assertSourceOwner, handleOwnedRequest,
  reply, diagnosticSink, maximumFrameBytes = 2 * 1024 * 1024 }) {
  if (!child || typeof serverId !== 'string' || typeof assertSourceOwner !== 'function'
    || typeof handleOwnedRequest !== 'function' || typeof reply !== 'function') throw new Error('Actual Native Source host callbacks are required');
  const stopped = new AbortController();
  const seen = new Set();
  let closed = false;
  let pending = 0;
  let queue = Promise.resolve();
  const reject = (id, code) => { if (!closed) reply({ jsonrpc: '2.0', id: validId(id) ? id : null,
    error: { code: -32601, message: code } }); };
  const close = () => { if (!closed) { closed = true; stopped.abort(); } };
  child.once?.('close', close);
  return Object.freeze({
    close,
    receiveBackend(message) {
      if (!isNativeRemoteHostMethod(message?.method)) return false;
      if (closed) return true;
      if (!METHODS.has(message.method) || !validId(message.id) || message.jsonrpc !== '2.0'
        || Buffer.byteLength(JSON.stringify(message)) > maximumFrameBytes) {
        reject(message.id, 'REMOTE_HOST_PRIVATE_REQUEST_INVALID'); return true;
      }
      const key = `${typeof message.id}:${message.id}`;
      if (seen.has(key)) { reject(message.id, 'REMOTE_HOST_RECONCILE_ORIGINAL'); return true; }
      if (pending >= 8 || seen.size >= 4096) { reject(message.id, 'REMOTE_HOST_CAPACITY'); return true; }
      // Record before any possible effect. Repeated requests must observe the
      // original receipt with a new read request, never invoke the handler again.
      seen.add(key); pending += 1;
      queue = queue.then(async () => {
        let stage = 'backchannel_source_owner';
        if (message.method === NATIVE_REMOTE_HOST_PREFIX + 'open') observeNativeRemoteHostStage('open_received', null, diagnosticSink);
        try {
          if (closed) return;
          assertSourceOwner({ child, serverId });
          stage = 'backchannel_owned_request';
          const result = await handleOwnedRequest({ child, serverId, method: message.method,
            params: message.params, signal: stopped.signal });
          if (closed) return;
          stage = 'backchannel_receipt_owner';
          assertSourceOwner({ child, serverId });
          reply({ jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
          observeNativeRemoteHostStage(stage, error, diagnosticSink);
          // Raw errors can contain account paths or credentials. A failure does
          // not prove the request had no effect; preserve original-ID recovery.
          reject(message.id, 'REMOTE_HOST_RECONCILE_ORIGINAL');
        } finally { pending -= 1; }
      });
      return true;
    },
  });
}

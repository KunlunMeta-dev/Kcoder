import { createHash } from 'node:crypto';
import { isAttachmentDraftRetainResult } from '../shared/generated/contractGuards.attachment-drafts.mjs';

const RESOURCE_OWNERSHIP_CONFLICT = -32048;
const RESOURCE_NOT_READY = -32049;

export const DURABLE_DRAFT_CAPABILITY = 'durableAttachmentDraftsV1';
/** A lost/partial retain reply must not make Native-owned draft files look
 * like public historical attachments just because Gateway maps are empty. */
export function unclaimedDurableDraft(broker, path) {
  const key = `attachment\0${path}`;
  return /(?:^|[\\/])draft-attachments[\\/]d-[a-f0-9]{64}[\\/]content[\\/].+/i.test(path) &&
    !broker.resourceOwners.has(key) && !broker.materializedAttachments.has(key);
}
export function durableDraftReady(broker, message = broker.initializeResponse) {
  return typeof broker.draftAttachmentAuthority === 'function' &&
    message?.result?.capabilities?.experimental?.[DURABLE_DRAFT_CAPABILITY] === true;
}

export function handleDurableDraftRequest(broker, client, request) {
  if (request.method?.startsWith('attachment/draft/')) {
    if (request.id !== undefined) client.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Draft parent operations are not public RPC' } });
    return true;
  }
  if (request.method !== 'gateway/attachments/retain' || request.params?.durable !== true) return false;
  if (request.id !== undefined) void retainDurableDraft(broker, client, request).then(result => {
    if (broker.clients.has(client)) client.send({ jsonrpc: '2.0', id: request.id, result });
  }).catch(error => {
    if (broker.clients.has(client)) client.send({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32048, message: error.message } });
  });
  return true;
}

/** Native records own bytes and binding. These maps only project this live
 * connection; an empty/new Gateway never adopts a path without Native proof. */
export async function retainDurableDraft(broker, client, request) {
  const fail = message => { throw Object.assign(new Error(message), { code: -32048 }); };
  const { paths, threadId } = request.params ?? {};
  if (!client.initialized) fail('Initialize is required before durable draft retention');
  if (!durableDraftReady(broker)) fail('Durable draft attachments require an updated Gateway and backend');
  if (Object.keys(request.params ?? {}).some(key => !['paths', 'threadId', 'durable'].includes(key)) ||
      !Array.isArray(paths) || !paths.length || paths.length > 32 || new Set(paths).size !== paths.length ||
      paths.some(path => typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) ||
      typeof threadId !== 'string' || !threadId || threadId.length > 128) fail('Invalid durable draft request');
  const authorizationOwner = client.authorizationOwner;
  if (typeof authorizationOwner !== 'string' || !authorizationOwner) fail('Authenticated draft owner required');
  const authority = broker.draftAttachmentAuthority(client);
  const ownerScope = createHash('sha256').update(JSON.stringify(['kcoder.composer-draft.v1', authority, authorizationOwner, threadId])).digest('hex');
  const current = () => {
    try { return !broker.closed && broker.clients.has(client) && client.authorizationOwner === authorizationOwner &&
      JSON.stringify(broker.draftAttachmentAuthority(client)) === JSON.stringify(authority); }
    catch { return false; }
  };
  let recoverOnly = false;
  for (const path of paths) {
    const key = `attachment\0${path}`;
    const owner = broker.resourceOwners.get(key);
    const binding = broker.retainedAttachmentBindings.get(key);
    if ((owner && owner !== client) || broker.materializedAttachments.has(key) ||
        (binding && (binding.owner !== authorizationOwner || binding.threadId !== threadId || binding.cleaning || binding.cleared)))
      fail('Draft belongs to another owner or has already been materialized');
    if (!owner && !binding) recoverOnly = true;
  }
  if (!current()) fail('Draft owner changed');
  const response = await new Promise(resolve => broker.sendInternalRequest('attachment/draft/retain',
    { threadId, ownerScope, paths, recoverOnly }, { onResponse: resolve }));
  if (response.error) throw Object.assign(new Error(response.error.message || 'Draft retain unconfirmed'), { code: response.error.code ?? -32048 });
  const drafts = response.result?.drafts;
  if (!isAttachmentDraftRetainResult(response.result) || drafts.length !== paths.length ||
      drafts.some((item, i) => item?.sourcePath !== paths[i] || typeof item.path !== 'string' || !item.path || item.path.length > 4096) ||
      new Set(drafts.map(item => item.path)).size !== paths.length) fail('Invalid Native draft receipt');
  // A late retain is still durable, but it transfers no rights to a new caller.
  // Keep it protected from ordinary unowned-path reads until its owner returns.
  const attached = current();
  if (broker.retainedAttachmentBindings.size + drafts.filter(item =>
    !broker.retainedAttachmentBindings.has(`attachment\0${item.path}`)).length > 4096)
    fail('Retained attachment cleanup ledger capacity reached');
  // Another request may have claimed or consumed this path while Native was
  // replying. Recheck the live projection before assigning any resource.
  for (const path of [...paths, ...drafts.map(item => item.path)]) {
    const key = `attachment\0${path}`;
    const owner = broker.resourceOwners.get(key);
    const binding = broker.retainedAttachmentBindings.get(key);
    if ((owner && owner !== client) || broker.materializedAttachments.has(key) ||
        (binding && (binding.owner !== authorizationOwner || binding.threadId !== threadId || binding.cleaning || binding.cleared)))
      fail('Draft ownership changed while retaining');
  }
  for (const item of drafts) {
    const key = `attachment\0${item.path}`;
    broker.persistentResources.add(key);
    broker.durableDraftPaths.add(key);
    if (!broker.retainedAttachmentBindings.has(key))
      broker.retainedAttachmentBindings.set(key, { threadId, owner: authorizationOwner, cleared: false, cleaning: false });
    if (attached) broker.resourceOwners.set(key, client);
  }
  if (!attached) fail('Draft owner changed after durable retention');
  return { retained: true, paths, drafts };
}

export function handleAttachmentDrafts(broker, client, request) {
  if (handleDurableDraftRequest(broker, client, request)) return true;
  if (request.method !== "gateway/attachments/retain") return false;
  if (request.id === undefined) return true;
  const requestedPaths = request.params?.paths;
  const paths = Array.isArray(requestedPaths)
    ? [
        ...new Set(
          requestedPaths.filter(
            (path) => typeof path === "string" && path.length > 0,
          ),
        ),
      ]
    : [];
  if (paths.length === 0 || paths.length !== requestedPaths.length) {
    client.send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32602,
        message: "attachment retain requires unique non-empty paths",
      },
    });
    return true;
  }
  const keys = paths.map((path) => `attachment\0${path}`);
  const threadId = request.params?.threadId;
  // A disconnected Composer may reclaim only its exact authenticated
  // thread binding. A live peer, materialized input or unknown path is not a draft.
  if (keys.some(key => {
    const owner = broker.resourceOwners.get(key);
    if (owner === client) return false;
    const binding = broker.retainedAttachmentBindings.get(key);
    return owner || !threadId || !client.authorizationOwner || !binding ||
      binding.owner !== client.authorizationOwner || binding.threadId !== threadId ||
      binding.cleared || binding.cleaning || !broker.persistentResources.has(key) || broker.materializedAttachments.has(key);
  })) {
    client.send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: RESOURCE_OWNERSHIP_CONFLICT,
        message: "attachment does not belong to this Gateway client",
      },
    });
    return true;
  }
  if (threadId !== undefined && (typeof threadId !== "string" || !threadId || threadId.length > 128 || !client.authorizationOwner)) {
    client.send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Scoped attachment retention requires a thread and authenticated Gateway owner" } }); return true;
  }
  if (threadId && keys.some(key => {
    const prior = broker.retainedAttachmentBindings.get(key);
    return prior && (prior.cleared || prior.threadId !== threadId || prior.owner !== client.authorizationOwner);
  })) {
    client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment is bound to another thread or authorization" } }); return true;
  }
  if (threadId && keys.some(key => broker.retainedAttachmentBindings.get(key)?.cleaning)) {
    client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained attachment cleanup is pending; path cannot be retained again" } }); return true;
  }
  if (threadId && broker.retainedAttachmentBindings.size + keys.filter(key => !broker.retainedAttachmentBindings.has(key)).length > 4096) {
    client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained attachment cleanup ledger capacity reached" } }); return true;
  }
  for (const key of keys) {
    broker.resourceOwners.set(key, client);
    broker.persistentResources.add(key);
    if (threadId && !broker.retainedAttachmentBindings.has(key)) broker.retainedAttachmentBindings.set(key, { threadId, owner: client.authorizationOwner, cleared: false, cleaning: false });
  }
  client.send({
    jsonrpc: "2.0",
    id: request.id,
    result: { retained: true, paths },
  });
  return true;
}

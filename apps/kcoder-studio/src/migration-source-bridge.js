import { createHash } from 'node:crypto';
import { INSTRUCTION_TRANSFER_CAPABILITY } from '../shared/migrationInstructions.mjs';
import { isContract } from '../shared/generated/validator.mjs';
import { MIGRATION_SOURCE_INTERNAL_PREFIX as PREFIX, MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY, MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY, MIGRATION_SOURCE_ATTEMPT_CAPABILITY, MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY, MIGRATION_SOURCE_MEMORY_CAPABILITY, MIGRATION_SOURCE_DEFINITIONS_CAPABILITY, MIGRATION_SOURCE_PROJECTS_CAPABILITY, MIGRATION_SOURCE_PLUGINS_CAPABILITY, MIGRATION_SOURCE_UPLOADED_CAPABILITY, MIGRATION_SOURCE_UPLOADED_PLUGINS_CAPABILITY, MIGRATION_SOURCE_ADOPTION_CAPABILITY, MigrationSourceBridgeError } from './migration-source-private.js';

const ENDPOINT = Symbol('verified-migration-endpoint');
const CHUNK_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const atom = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw new MigrationSourceBridgeError(reason); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));

function identity(value) {
  if (!exact(value, ['instanceId', 'accountId']) || !UUID.test(value.instanceId) || !SHA.test(value.accountId)) {
    fail('source_transfer_invalid_response');
  }
  return { instanceId: value.instanceId, accountId: value.accountId };
}

function scope(value) {
  if (!exact(value, ['ownerId', 'generation', 'targetFingerprint', 'principal']) || !atom(value.ownerId) ||
      !(atom(value.generation) || (Number.isSafeInteger(value.generation) && value.generation >= 0)) ||
      !SHA.test(value.targetFingerprint)) fail('source_transfer_authority_unavailable');
  const principal = value.principal;
  if (!(exact(principal, ['kind']) && principal.kind === 'localOs') &&
      !(exact(principal, ['kind', 'principalId']) && principal.kind === 'verifiedAccount' && atom(principal.principalId))) {
    fail('source_transfer_authority_unavailable');
  }
  return { ownerId: value.ownerId, generation: value.generation, targetFingerprint: value.targetFingerprint,
    principal: principal.kind === 'localOs' ? { kind: 'localOs' } : { kind: 'verifiedAccount', principalId: principal.principalId } };
}

/** Composition-root API only: captureCurrent reads authenticated Gateway state,
 * never request JSON. Probe and launch must share this same identity fence. */
export function captureMigrationSourceScope(captureCurrent) {
  if (typeof captureCurrent !== 'function') fail('source_transfer_authority_unavailable');
  let captured;
  try { captured = scope(captureCurrent()); } catch { fail('source_transfer_authority_unavailable'); }
  Object.freeze(captured.principal); Object.freeze(captured);
  const signature = hash(captured);
  return Object.freeze({ captured,
    assertCurrent() {
      let current;
      try { current = scope(captureCurrent()); } catch { fail('source_transfer_authority_changed'); }
      if (hash(current) !== signature) fail('source_transfer_authority_changed');
    },
  });
}

/** Native independently checks the private parent proof; these fences protect
 * delayed Gateway continuations as well as a closed dedicated broker. */
export function captureMigrationSourceEndpoint({ broker, captureCurrent }) {
  if (!broker || typeof broker.sendMigrationSourceRequest !== 'function') fail('source_transfer_authority_unavailable');
  const fence = captureMigrationSourceScope(captureCurrent);
  return Object.freeze({ [ENDPOINT]: true, captured: fence.captured,
    supportsPrivateCredentials() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY] === true;
    },
    supportsPrivateCredentialSourceObservation() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY] === true;
    },
    supportsPrivateCredentialPreparations() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY] === true;
    },
    supportsPrivateCredentialBundles() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY] === true;
    },
    supportsTargetRecovery() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY] === true;
    },
    supportsAttempts() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_ATTEMPT_CAPABILITY] === true;
    },
    supportsAdoption() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_ADOPTION_CAPABILITY] === true;
    },
    supportsUploadedSource() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_UPLOADED_CAPABILITY] === true;
    },
    supportsProjects() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PROJECTS_CAPABILITY] === true;
    },
    supportsPlugins() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PLUGINS_CAPABILITY] === true;
    },
    supportsUploadedPlugins() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_UPLOADED_PLUGINS_CAPABILITY] === true;
    },
    supportsInstructions() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[INSTRUCTION_TRANSFER_CAPABILITY] === true;
    },
    supportsDefinitions() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_DEFINITIONS_CAPABILITY] === true;
    },
    supportsMemory() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_MEMORY_CAPABILITY] === true;
    },
    supportsAssetIdentity() {
      this.assertCurrent();
      return broker.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY] === true;
    },
    assertCurrent() {
      fence.assertCurrent();
      if (broker.closed) fail('source_transfer_authority_changed');
    },
    async request(method, params, proof) {
      this.assertCurrent();
      let response;
      try { response = await broker.sendMigrationSourceRequest(PREFIX + method, params, proof); }
      catch { this.assertCurrent(); fail('source_transfer_outcome_unknown'); }
      this.assertCurrent();
      // Preserve only reviewed Native reasons; arbitrary error text stays private.
      if (['source_transfer_projects_update_required', 'source_transfer_plugins_update_required',
        'source_transfer_scoped_instructions_update_required', 'source_transfer_busy',
        'source_transfer_recovery_required'].includes(response?.error?.message)) fail(response.error.message);
      if (method.includes('/private/') && isContract('MigrationSourceCredentialError', response?.error?.message)) fail(response.error.message);
      if (!response || response.error || !Object.hasOwn(response, 'result')) fail('source_transfer_outcome_unknown');
      return response.result;
    },
  });
}

function selections(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) fail('source_transfer_invalid_request');
  const seen = new Set();
  const result = value.map(selection => {
    const keys = selection?.kind === 'instructions' ? ['kind', 'captureId'] : ['history', 'projects'].includes(selection?.kind) ? ['kind', 'catalogId', 'sourceHandle'] : selection?.kind === 'plugin' ? ['kind', 'candidateId'] : ['kind', 'sourceId'];
    if (!exact(selection, keys) || !['configuration', 'assets', 'history', 'projects', 'plugin', 'instructions'].includes(selection.kind) ||
        !keys.filter(key => key !== 'kind').every(key => atom(selection[key])) || selection.kind === 'instructions' && !UUID.test(selection.captureId)) fail('source_transfer_invalid_request');
    const canonical = selection.kind === 'instructions' ? { kind: 'instructions', captureId: selection.captureId } : ['history', 'projects'].includes(selection.kind)
      ? { kind: selection.kind, catalogId: selection.catalogId, sourceHandle: selection.sourceHandle }
      : selection.kind === 'plugin' ? { kind: 'plugin', candidateId: selection.candidateId } : { kind: selection.kind, sourceId: selection.sourceId };
    const key = hash(canonical);
    if (seen.has(key)) fail('source_transfer_invalid_request');
    seen.add(key);
    return canonical;
  });
  return result;
}
export const normalizeMigrationSourceSelections = selections;

function state(result) {
  const keys = Object.hasOwn(result ?? {}, 'selectionDigest') ? ['state', 'selectionDigest', 'capture', 'snapshotControl']
    : Object.hasOwn(result ?? {}, 'workerRunning') ? ['state', 'workerRunning'] : ['state'];
  if (!exact(result, keys)) {
    fail('source_transfer_invalid_response');
  }
  const value = result.state;
  if (value === null) return null;
  if (!exact(value, ['sequence', 'cancelWatermark', 'cancelled', 'ready']) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.cancelWatermark) || value.cancelWatermark < 0 ||
      typeof value.cancelled !== 'boolean' || typeof value.ready !== 'boolean') fail('source_transfer_invalid_response');
  return { sequence: value.sequence, cancelWatermark: value.cancelWatermark, cancelled: value.cancelled, ready: value.ready };
}

function capture(value) {
  const errors = new Set(['source_transfer_selection_unavailable', 'source_transfer_cancelled', 'source_transfer_busy',
    'source_transfer_revision_conflict', 'source_transfer_recovery_required', 'source_transfer_source_changed',
    'source_transfer_authority_changed', 'source_transfer_owner_changed', 'source_transfer_capture_interrupted', 'source_transfer_capture_failed']);
  if (!exact(value, ['status', 'errorCode']) || !['idle', 'running', 'failed', 'interrupted', 'ready'].includes(value.status) ||
      !(value.errorCode === null || errors.has(value.errorCode))) fail('source_transfer_invalid_response');
  return structuredClone(value);
}

function projection(pair, value) {
  const sourceCapture = pair.observation.sourceCapture;
  const sourceSnapshotControl = pair.observation.sourceSnapshotControl;
  const targetWorkerRunning = pair.observation.targetWorkerRunning || pair.targetInFlight();
  const cancelled = value.sourceState?.cancelled || sourceSnapshotControl?.cancelled || value.targetState?.cancelled || pair.observation.targetAdmissionControl?.cancelled;
  const phase = cancelled ? sourceCapture.status === 'running' || targetWorkerRunning ? 'cancelling' : 'cancelled'
    : value.phase !== 'ready' && ['failed', 'interrupted'].includes(sourceCapture.status) ? sourceCapture.status : value.phase;
  return { ...value, phase, sourceCapture: structuredClone(sourceCapture), sourceSnapshotControl, targetWorkerRunning,
    targetAdmissionControl: pair.observation.targetAdmissionControl ?? null };
}

function targetSummary(value, requestId) {
  if (!exact(value, ['state', 'workerRunning', 'receipt', 'progress', 'admissionControl']) ||
      typeof value.workerRunning !== 'boolean') fail('source_transfer_invalid_response');
  const targetState = state({ state: value.state });
  const admissionControl = state({ state: value.admissionControl });
  if (admissionControl?.ready) fail('source_transfer_invalid_response');
  const saved = receipt({ receipt: value.receipt }, requestId);
  const progress = value.progress;
  if (targetState === null) {
    if (progress !== null || saved !== null) fail('source_transfer_invalid_response');
  } else if (!exact(progress, ['manifestSha256', 'entries', 'totalBytes', 'acceptedBytes', 'partsComplete']) ||
      !SHA.test(progress.manifestSha256) || !Number.isSafeInteger(progress.entries) || progress.entries < 1 || progress.entries > 1024 ||
      !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 0 || progress.totalBytes > MAX_TRANSFER_BYTES ||
      !Number.isSafeInteger(progress.acceptedBytes) || progress.acceptedBytes < 0 || progress.acceptedBytes > progress.totalBytes ||
      progress.partsComplete !== (progress.acceptedBytes === progress.totalBytes) ||
      targetState.ready !== (saved !== null) || saved && (saved.manifestSha256 !== progress.manifestSha256 ||
        saved.bytes !== progress.totalBytes || saved.entries !== progress.entries || !progress.partsComplete)) fail('source_transfer_invalid_response');
  return { targetState, admissionControl, receipt: saved, progress: structuredClone(progress), workerRunning: value.workerRunning };
}

function targetProjection(requestId, summary, inFlight = false) {
  const running = summary.workerRunning || inFlight;
  const cancelled = summary.admissionControl?.cancelled || summary.targetState?.cancelled;
  const phase = cancelled ? running ? 'cancelling' : 'cancelled' : summary.receipt ? 'ready'
    : summary.targetState && !summary.progress.partsComplete ? 'incomplete' : 'pending';
  return { requestId, scope: 'target', sourceObserved: false, phase, sourceState: null, sourceCapture: null,
    sourceSnapshotControl: null, targetState: summary.targetState, targetAdmissionControl: summary.admissionControl,
    targetWorkerRunning: running, receipt: summary.receipt, progress: summary.progress };
}

function receipt(result, requestId, manifest) {
  if (!exact(result, ['receipt'])) fail('source_transfer_invalid_response');
  const value = result.receipt;
  if (value === null) return null;
  if (!exact(value, ['requestId', 'manifestSha256', 'entries', 'bytes']) || value.requestId !== requestId ||
      !SHA.test(value.manifestSha256) || !Number.isSafeInteger(value.entries) || value.entries < 1 || value.entries > 1024 ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_TRANSFER_BYTES ||
      (manifest && (value.manifestSha256 !== manifest.digest || value.entries !== manifest.value.entries.length ||
        value.bytes !== manifest.totalBytes))) fail('source_transfer_invalid_response');
  return { requestId: value.requestId, manifestSha256: value.manifestSha256, entries: value.entries, bytes: value.bytes };
}

function manifest(result, requestId, sourceAuthority, destination) {
  if (!exact(result, ['manifest', 'manifestSha256']) || !SHA.test(result.manifestSha256)) fail('source_transfer_invalid_response');
  const value = result.manifest;
  if (!exact(value, ['version', 'requestId', 'source', 'destination', 'entries']) || value.version !== 1 ||
      value.requestId !== requestId || hash(value.source) !== hash(sourceAuthority) || hash(value.destination) !== hash(destination) ||
      !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 1024 ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) fail('source_transfer_invalid_response');
  let totalBytes = 0;
  const ids = new Set();
  for (const entry of value.entries) {
    if (!exact(entry, ['id', 'bytes', 'sha256', 'content']) || !/^e\d{4}-\d{4}$/.test(entry.id) || ids.has(entry.id) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA.test(entry.sha256)) fail('source_transfer_invalid_response');
    ids.add(entry.id); totalBytes += entry.bytes;
    if (totalBytes > MAX_TRANSFER_BYTES) fail('source_transfer_invalid_response');
    if (Object.hasOwn(entry.content ?? {}, 'uploadedSource')) {
      const origin = entry.content.uploadedSource;
      if (!['configuration_inventory', 'work_asset', 'history', 'plugin_package'].includes(entry.content.kind) ||
          !exact(origin, ['operationId', 'manifestSha256']) || !UUID.test(origin.operationId) || !SHA.test(origin.manifestSha256)) fail('source_transfer_invalid_response');
    }
    if (entry.content?.kind === 'configuration_inventory' && (!SHA.test(entry.content.sourceIdentity) ||
        !['user', 'user-mcp', 'project', 'project-mcp', 'project-local', 'project-effective', 'codex-project-layers'].includes(entry.content.source_scope))) fail('source_transfer_invalid_response');
    if (entry.content?.kind === 'project_inventory' && (!exact(entry.content, ['kind', 'source', 'format', 'sourceIdentity', 'source_revision', 'metadata'])
      || !['claude-code', 'codex'].includes(entry.content.source) || entry.content.format !== 'kcoder-project-inventory/1'
      || !SHA.test(entry.content.sourceIdentity) || !SHA.test(entry.content.source_revision)
      || !entry.id.endsWith('-0000') || entry.bytes < 1 || entry.bytes > 128 * 1024
      || !isContract('MigrationProjectReceivedMetadata', entry.content.metadata)
      || entry.content.metadata.roots > 16 || !entry.content.metadata.displayName || Buffer.byteLength(entry.content.metadata.displayName) > 4096
      || /[\p{Cc}]/u.test(entry.content.metadata.displayName)
      || entry.content.metadata.formatRevision !== (entry.content.source === 'codex' ? 'codex-project-registry/sqlite/1' : 'claude-project-registry/json/1'))) fail('source_transfer_invalid_response');
    if (entry.content?.kind === 'instruction_bundle' && (!exact(entry.content, ['kind', 'source', 'parser_revision'])
      || !['claude-code', 'codex'].includes(entry.content.source) || entry.content.parser_revision !== 'scoped-instructions/v2'
      || !entry.id.endsWith('-0000') || entry.bytes < 1 || entry.bytes > 64 * 1024 * 1024)) fail('source_transfer_invalid_response');
    if (entry.content?.kind === 'plugin_package') {
      const origin = entry.content.origin;
      const keys = ['kind', 'origin', 'format'];
      if (Object.hasOwn(entry.content, 'uploadedSource')) keys.push('uploadedSource');
      if (!exact(entry.content, keys) || entry.content.format !== 'kcoder-plugin-tar/1' || !entry.id.endsWith('-0000') ||
          !exact(origin, ['source', 'logicalIdentity', 'name', 'version', 'scope', 'sourceEnabled', 'pending', 'package']) ||
          !['claude-code', 'codex'].includes(origin.source) || !SHA.test(origin.logicalIdentity) ||
          typeof origin.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(origin.name) ||
          !(origin.version === null || typeof origin.version === 'string' && /^[A-Za-z0-9._+-]{1,128}$/.test(origin.version)) ||
          !['user', 'project', 'local'].includes(origin.scope) || !(origin.sourceEnabled === null || typeof origin.sourceEnabled === 'boolean') ||
          !Array.isArray(origin.pending) || origin.pending.length > 1 || origin.pending.some(code => code !== 'plugin_project_mapping_required') ||
          !exact(origin.package, ['sha256', 'files', 'bytes']) || !SHA.test(origin.package.sha256) ||
          !Number.isSafeInteger(origin.package.files) || origin.package.files < 1 || origin.package.files > 10_000 ||
          !Number.isSafeInteger(origin.package.bytes) || origin.package.bytes < 0 || origin.package.bytes > 256 * 1024 * 1024) fail('source_transfer_invalid_response');
    }
    if (entry.content?.kind === 'work_asset') {
      const content = entry.content;
      const keys = ['kind', 'source', 'category', 'scope', 'asset', 'relative', 'source_revision', 'source_executable'];
      if (Object.hasOwn(content, 'sourceIdentity')) keys.push('sourceIdentity');
      if (Object.hasOwn(content, 'memoryProvenance')) keys.push('memoryProvenance');
      if (Object.hasOwn(content, 'uploadedSource')) keys.push('uploadedSource');
      const relative = value => typeof value === 'string' && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 1024 &&
        value.split('/').length <= 16 && value.split('/').every(part => part && !['.', '..'].includes(part) && !/[\\:\p{Cc}]/u.test(part) && !/[. ]$/.test(part));
      const provenanceScope = exact(content.scope, ['kind']) && content.scope.kind === 'global' ||
        exact(content.scope, ['kind', 'root']) && content.scope.kind === 'project' && typeof content.scope.root === 'string' &&
        content.scope.root.length > 0 && content.scope.root.length <= 4096 && !/[\p{Cc}]/u.test(content.scope.root);
      if (!exact(content, keys) || !['claude-code', 'codex'].includes(content.source) ||
          !['skill', 'command', 'instructions', 'memory', 'agent', 'hook'].includes(content.category) || !provenanceScope ||
          !relative(content.asset) || !relative(content.relative) || !SHA.test(content.source_revision) ||
          typeof content.source_executable !== 'boolean' || Object.hasOwn(content, 'sourceIdentity') && !SHA.test(content.sourceIdentity)) {
        fail('source_transfer_invalid_response');
      }
      if (Object.hasOwn(content, 'memoryProvenance')) {
        const origin = content.memoryProvenance;
        if (content.category !== 'memory' || !isContract('ImportedMemoryProvenance', origin) ||
            origin.source !== content.source || origin.sourceFile !== content.asset ||
            origin.sourceRevision !== content.source_revision || origin.factsVerified !== false ||
            Object.hasOwn(origin, 'migrationJobId') || !atom(origin.sourceGroup)) fail('source_transfer_invalid_response');
      }
    }
  }
  // Native uses canonical serde struct serialization for the digest. Gateway
  // checks its bound response digest and every chunk; target revalidates the
  // whole manifest with the same Native serializer, never a JS key-order hash.
  return { value, digest: result.manifestSha256, totalBytes };
}

function destination(result, requestId, targetAuthority) {
  if (!exact(result, ['grantId', 'authority', 'scope']) || result.grantId !== requestId ||
      !SHA.test(result.scope) || hash(identity(result.authority)) !== hash(targetAuthority)) fail('source_transfer_invalid_response');
  return result;
}

function part(result, entry, digest) {
  if (!exact(result, ['receipt'])) fail('source_transfer_invalid_response');
  const value = result.receipt;
  if (!exact(value, ['manifestSha256', 'entryId', 'acceptedParts', 'acceptedBytes']) ||
      value.manifestSha256 !== digest || value.entryId !== entry.id ||
      !Number.isSafeInteger(value.acceptedParts) || value.acceptedParts < 0 ||
      value.acceptedParts > Math.ceil(entry.bytes / CHUNK_BYTES) ||
      value.acceptedBytes !== Math.min(entry.bytes, value.acceptedParts * CHUNK_BYTES)) fail('source_transfer_invalid_response');
  return value;
}

function chunk(result, requestId, entry, index, digest) {
  if (!exact(result, ['requestId', 'manifestSha256', 'entryId', 'index', 'sha256', 'dataBase64']) ||
      result.requestId !== requestId || result.manifestSha256 !== digest || result.entryId !== entry.id ||
      result.index !== index || !SHA.test(result.sha256) || typeof result.dataBase64 !== 'string' ||
      result.dataBase64.length > 4 * Math.ceil(CHUNK_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.dataBase64)) {
    fail('source_transfer_invalid_response');
  }
  const decoded = Buffer.from(result.dataBase64, 'base64');
  try {
    if (decoded.length !== Math.min(CHUNK_BYTES, entry.bytes - index * CHUNK_BYTES) ||
        decoded.toString('base64') !== result.dataBase64 ||
        createHash('sha256').update(decoded).digest('hex') !== result.sha256) fail('source_transfer_invalid_response');
  } finally { decoded.fill(0); }
  return result;
}

function assertEndpoint(endpoint) {
  if (!endpoint?.[ENDPOINT]) fail('source_transfer_authority_unavailable');
  endpoint.assertCurrent();
}

/** One bridge owns only its own in-flight RPCs. Durable state and cancellation
 * remain Native. No source contents or credentials are written into Gateway
 * state, returned to clients, or included in error strings. */
export class MigrationSourceBridge {
  #active = new Map();
  #bindings = new Map();
  #initialization = new WeakMap();

  constructor({ maxOperations = 256, wait = () => new Promise(resolve => setTimeout(resolve, 50)) } = {}) {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 256 || typeof wait !== 'function') {
      fail('source_transfer_invalid_request');
    }
    this.maxOperations = maxOperations;
    this.wait = wait;
  }

  #initializationCall(endpoint, requestId, operation) {
    let requests = this.#initialization.get(endpoint);
    if (!requests) { requests = new Map(); this.#initialization.set(endpoint, requests); }
    let lane = requests.get(requestId);
    if (!lane) { lane = { tail: Promise.resolve(), pending: 0 }; requests.set(requestId, lane); }
    if (lane.pending >= 64) fail('source_transfer_busy');
    lane.pending++;
    const result = lane.tail.then(operation);
    // Only settlement orders the next call. The original result/error is still
    // returned unchanged; no Native recovery error becomes a successful read.
    lane.tail = result.then(() => {}, () => {});
    void lane.tail.then(() => { if (--lane.pending === 0 && requests.get(requestId) === lane) requests.delete(requestId); });
    return result;
  }

  async #pair(requestId, source, target, check = () => {}) {
    if (!UUID.test(requestId)) fail('source_transfer_invalid_request');
    assertEndpoint(source); assertEndpoint(target); check();
    if (source.captured.ownerId !== target.captured.ownerId) fail('source_transfer_authority_changed');
    const call = async (endpoint, method, params, proof) => {
      check(); source.assertCurrent(); target.assertCurrent();
      const value = await endpoint.request(method, params, proof);
      check(); source.assertCurrent(); target.assertCurrent();
      return value;
    };
    const sourceIdentity = await call(source, 'identity', {});
    const targetIdentity = await call(target, 'identity', {});
    for (const result of [sourceIdentity, targetIdentity]) {
      if (!exact(result, ['authority', 'chunkBytes', 'maxManifestBytes']) || result.chunkBytes !== CHUNK_BYTES ||
          result.maxManifestBytes !== MAX_MANIFEST_BYTES) fail('source_transfer_invalid_response');
    }
    const sourceAuthority = identity(sourceIdentity.authority), targetAuthority = identity(targetIdentity.authority);
    const observation = { sourceCapture: { status: 'idle', errorCode: null }, sourceSnapshotControl: null, targetWorkerRunning: false, targetAdmissionControl: null };
    const descriptor = (endpoint, authority) => ({ authority, targetFingerprint: endpoint.captured.targetFingerprint,
      principal: endpoint.captured.principal });
    const proof = { version: 1, requestId, source: descriptor(source, sourceAuthority), target: descriptor(target, targetAuthority) };
    const sourcePeer = await call(source, 'peer/accept', { requestId, role: 'source' }, proof);
    const targetPeer = await call(target, 'peer/accept', { requestId, role: 'target' }, proof);
    if (!exact(sourcePeer, ['peerRef']) || !atom(sourcePeer.peerRef) || !exact(targetPeer, ['peerRef']) || !atom(targetPeer.peerRef)) {
      fail('source_transfer_invalid_response');
    }
    const targetCall = async (method, params = {}) => {
      const result = await call(target, `target/${method}`, { requestId, peerRef: targetPeer.peerRef, ...params });
      if (['state', 'begin', 'cancel', 'resume'].includes(method)) {
        if (!exact(result, ['state', 'workerRunning']) || typeof result.workerRunning !== 'boolean') fail('source_transfer_invalid_response');
        observation.targetWorkerRunning = result.workerRunning;
        if (target.supportsTargetRecovery()) {
          const observe = () => call(target, 'target/summary', { requestId, peerRef: targetPeer.peerRef });
          // State/begin already hold this lane. Control mutations dispatch
          // independently, then wait only their follow-up observation.
          const summary = targetSummary(await (['state', 'begin'].includes(method)
            ? observe() : this.#initializationCall(target, requestId, observe)), requestId);
          observation.targetAdmissionControl = summary.admissionControl;
          observation.targetWorkerRunning ||= summary.workerRunning;
        }
      }
      return result;
    };
    const pair = { sourceAuthority, targetAuthority, observation, targetInFlight: () => this.#active.get(requestId)?.finishing === true,
      // Initial publication and observation share only this original endpoint/request.
      // Explicit cancellation retains its independent raw control lanes.
      sourceState: () => this.#initializationCall(source, requestId, () => pair.source('state')),
      prepareSource: params => this.#initializationCall(source, requestId, () => pair.source('prepare', params)),
      targetStateForCancel: () => targetCall('state'),
      source: async (method, params = {}) => {
        const result = await call(source, `source/${method}`, { requestId, peerRef: sourcePeer.peerRef, ...params });
        if (['state', 'prepare', 'capture', 'cancel', 'resume'].includes(method)) {
          if (!exact(result, ['state', 'selectionDigest', 'capture', 'snapshotControl']) ||
              (result.state === null ? result.selectionDigest !== null : !SHA.test(result.selectionDigest))) {
            fail('source_transfer_invalid_response');
          }
          observation.sourceCapture = capture(result.capture);
          observation.sourceSnapshotControl = state({ state: result.snapshotControl });
          const bound = this.#bindings.get(requestId);
          if (bound && result.selectionDigest) {
            if (bound.selectionDigest && bound.selectionDigest !== result.selectionDigest) fail('source_transfer_request_changed');
            bound.selectionDigest = result.selectionDigest;
          }
        }
        return result;
      },
      target: (method, params) => ['state', 'summary', 'begin'].includes(method)
        ? this.#initializationCall(target, requestId, () => targetCall(method, params)) : targetCall(method, params),
      route: hash([source.captured.targetFingerprint, source.captured.principal,
        sourceAuthority, target.captured.targetFingerprint, target.captured.principal, targetAuthority]),
      targetRoute: hash([target.captured.targetFingerprint, target.captured.principal, targetAuthority]),
    };
    return pair;
  }

  #bind(requestId, pair, selected) {
    const old = this.#bindings.get(requestId);
    const intent = selected ? hash(selected) : old?.intent;
    if (old && (old.route && old.route !== pair.route || old.targetRoute !== pair.targetRoute ||
        (selected && old.intent && old.intent !== intent))) fail('source_transfer_request_changed');
    if (!old && this.#bindings.size >= this.maxOperations) fail('source_transfer_operation_limit');
    this.#bindings.set(requestId, { route: pair.route, targetRoute: pair.targetRoute, intent, selectionDigest: old?.selectionDigest });
  }

  async #recoverTarget(requestId, target) {
    if (!UUID.test(requestId)) fail('source_transfer_invalid_request');
    assertEndpoint(target);
    if (!target.supportsTargetRecovery()) fail('source_transfer_authority_unavailable');
    const recovered = await target.request('peer/recover-target', { requestId });
    if (!exact(recovered, ['peerRef', 'targetAuthority']) || !atom(recovered.peerRef)) fail('source_transfer_invalid_response');
    const targetAuthority = identity(recovered.targetAuthority);
    const targetRoute = hash([target.captured.targetFingerprint, target.captured.principal, targetAuthority]);
    const old = this.#bindings.get(requestId);
    if (old && old.targetRoute !== targetRoute) fail('source_transfer_request_changed');
    if (!old && this.#bindings.size >= this.maxOperations) fail('source_transfer_operation_limit');
    this.#bindings.set(requestId, { ...old, targetRoute });
    return (method, params = {}) => {
      const invoke = () => target.request(`target/${method}`, { requestId, peerRef: recovered.peerRef, ...params });
      return ['summary', 'state'].includes(method) ? this.#initializationCall(target, requestId, invoke) : invoke();
    };
  }

  /** Trusted composition API. It exposes the same authenticated pair only to
   * the private relay; no method or peer proof is accepted from a public caller. */
  async privateCredentialSourceChannel({ requestId, source }) {
    if (!UUID.test(requestId)) fail('private_credentials_invalid_request');
    assertEndpoint(source);
    if (!source.supportsPrivateCredentials() || !source.supportsPrivateCredentialSourceObservation()) fail('private_credentials_update_required');
    return Object.freeze({ assertCurrent: () => source.assertCurrent(),
      source: (method, params) => source.request(`source/${method}`, { requestId, ...params }) });
  }

  async privateCredentialsChannel({ requestId, source, target, requireBundles = false, requirePreparations = false }) {
    assertEndpoint(target);
    if (requirePreparations && !target.supportsPrivateCredentialPreparations()) fail('private_credentials_update_required');
    if (!target.supportsPrivateCredentials() || requireBundles && !target.supportsPrivateCredentialBundles()) fail('private_credentials_update_required');
    if (!source) {
      const targetCall = await this.#recoverTarget(requestId, target);
      return Object.freeze({ assertCurrent: () => target.assertCurrent(), target: targetCall, supportsBundles: target.supportsPrivateCredentialBundles() });
    }
    assertEndpoint(source);
    if (!source.supportsPrivateCredentials()) fail('private_credentials_update_required');
    const pair = await this.#pair(requestId, source, target);
    this.#bind(requestId, pair);
    return Object.freeze({ assertCurrent() { source.assertCurrent(); target.assertCurrent(); },
      source: pair.source, target: pair.target, supportsBundles: target.supportsPrivateCredentialBundles() });
  }

  async received({ requestId, target, manifestSha256, pageIndex, includePlugins = false, includeInstructions = false, includeProjects = false }) {
    assertEndpoint(target);
    if (!target.supportsAdoption()) fail('source_transfer_unsupported_native');
    if (!SHA.test(manifestSha256) || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 102) fail('source_transfer_invalid_request');
    const call = await this.#recoverTarget(requestId, target);
    const result = await call('received/read', { manifestSha256, pageIndex, ...(includeProjects && target.supportsProjects() ? { includeProjects: true } : {}), ...(includeInstructions && target.supportsInstructions() ? { includeInstructions: true } : {}), ...(includePlugins && target.supportsPlugins() ? { includePlugins: true } : {}) });
    if ((!includeProjects || !target.supportsProjects()) && result?.items?.some(item => item.class === 'project')) fail('source_transfer_projects_update_required');
    if (!includePlugins && result?.items?.some(item => item.class === 'plugin')) fail('source_transfer_plugins_update_required');
    if ((!includeInstructions || !target.supportsInstructions()) && result?.items?.some(item => item.class === 'instructions')) fail('source_transfer_scoped_instructions_update_required');
    if (!isContract('MigrationSourceReceivedResult', result) || result.receipt.requestId !== requestId || result.receipt.manifestSha256 !== manifestSha256) fail('source_transfer_invalid_response');
    if (result.items.some(item => item.class !== 'project' ? item.project != null : item.category !== 'project' || item.projectScoped
      || !isContract('MigrationProjectReceivedMetadata', item.project) || item.project.roots > 16 || !item.project.displayName
      || Buffer.byteLength(item.project.displayName) > 4096 || /[\p{Cc}]/u.test(item.project.displayName)
      || item.project.formatRevision !== (item.source === 'codex' ? 'codex-project-registry/sqlite/1' : 'claude-project-registry/json/1'))) fail('source_transfer_invalid_response');
    return structuredClone(result);
  }
  async #adoption(options, operation, payload) {
    const { requestId, adoptionId, target } = options;
    if (!UUID.test(adoptionId)) fail('source_transfer_invalid_request');
    assertEndpoint(target);
    if (!target.supportsAdoption()) fail('source_transfer_unsupported_native');
    const call = await this.#recoverTarget(requestId, target);
    const result = await call(`adoption/${operation}`, { adoptionId, ...payload });
    if (!isContract('MigrationSourceAdoptionResult', result) || result.state !== null &&
        (result.state.adoptionId !== adoptionId || result.state.requestId !== requestId)) fail('source_transfer_invalid_response');
    return structuredClone(result);
  }
  async adoptionPrepare(options) {
    if (!SHA.test(options.manifestSha256) || !Array.isArray(options.selections) || !options.selections.length || options.selections.length > 64 ||
        options.selections.some(selection => !selection || typeof selection !== 'object' || Array.isArray(selection) ||
          Object.keys(selection).some(key => !['entryId', 'projectMapping'].includes(key)) || !/^e[0-9]{4}-[0-9]{4}$/.test(selection.entryId) ||
          Object.hasOwn(selection, 'projectMapping') && selection.projectMapping !== 'current_workspace') ||
        new Set(options.selections.map(selection => selection.entryId)).size !== options.selections.length) fail('source_transfer_invalid_request');
    const mappings = options.instructionMappings ?? [];
    if (!Array.isArray(mappings) || mappings.length > 64 || !mappings.every(mapping => isContract('MigrationSourceInstructionMapping', mapping))
      || mappings.reduce((total, mapping) => total + mapping.items.length, 0) > 128) fail('source_transfer_invalid_request');
    if (mappings.length && !options.target.supportsInstructions()) fail('source_transfer_scoped_instructions_update_required');
    return this.#adoption(options, 'prepare', { manifestSha256: options.manifestSha256, selections: structuredClone(options.selections),
      ...(mappings.length ? { instructionMappings: structuredClone(mappings) } : {}) });
  }
  async adoptionRead(options) { return this.#adoption(options, 'read', {}); }
  async adoptionResume(options) {
    const control = options.expectedControl;
    if (!exact(control, ['sequence', 'cancelWatermark']) || !Number.isSafeInteger(control.sequence) || control.sequence < 0 ||
        !Number.isSafeInteger(control.cancelWatermark) || control.cancelWatermark < 0) fail('source_transfer_invalid_request');
    return this.#adoption(options, 'resume', { expectedControl: { ...control } });
  }
  async adoptionCancel(options) {
    if (!UUID.test(options.commandId)) fail('source_transfer_invalid_request');
    return this.#adoption(options, 'cancel', { commandId: options.commandId });
  }

  async readTarget({ requestId, target }) {
    const call = await this.#recoverTarget(requestId, target);
    return targetProjection(requestId, targetSummary(await call('summary'), requestId), this.#active.get(requestId)?.finishing === true);
  }

  async savedSelections({ requestId, source, target }) {
    const pair = await this.#pair(requestId, source, target);
    this.#bind(requestId, pair);
    const view = await pair.source('state');
    if (view.state === null) return null;
    const result = await pair.source('intent');
    if (!exact(result, ['intent']) || !exact(result.intent, ['selections', 'selectionDigest']) ||
        result.intent.selectionDigest !== view.selectionDigest) fail('source_transfer_invalid_response');
    return selections(result.intent.selections);
  }

  async #attemptChannel({ requestId, source, target }, bootstrap = false) {
    assertEndpoint(target);
    if (!target.supportsAttempts()) fail('source_transfer_authority_unavailable');
    if (!source) return this.#recoverTarget(requestId, target);
    const pair = await this.#pair(requestId, source, target);
    this.#bind(requestId, pair);
    if (bootstrap) await pair.target('grant');
    return pair.target;
  }

  async readAttempt(options) {
    const call = await this.#attemptChannel(options);
    return this.#attemptView(await call('attempt/read', { attemptId: options.attemptId ?? null }), false);
  }
  #attemptView(result, claim) {
    if (!exact(result, claim ? ['admitted', 'view'] : ['view']) || claim && typeof result.admitted !== 'boolean') fail('source_transfer_invalid_response');
    const v = result.view;
    if (!exact(v, ['tracked', 'bindingDigest', 'selectionDigest', 'attempt', 'running']) || typeof v.tracked !== 'boolean' ||
        typeof v.running !== 'boolean' || !SHA.test(v.bindingDigest) || !(v.selectionDigest === null || SHA.test(v.selectionDigest))) fail('source_transfer_invalid_response');
    if (v.attempt !== null && (!exact(v.attempt, ['attemptId', 'kind', 'callDigest', 'selectionDigest']) ||
        !UUID.test(v.attempt.attemptId) || !['run', 'finish', 'target_resume'].includes(v.attempt.kind) ||
        !SHA.test(v.attempt.callDigest) || !(v.attempt.selectionDigest === null || SHA.test(v.attempt.selectionDigest)) ||
        (v.attempt.kind === 'run') !== (v.attempt.selectionDigest !== null) ||
        v.attempt.kind === 'run' && v.attempt.selectionDigest !== v.selectionDigest)) fail('source_transfer_invalid_response');
    if (!v.tracked && (v.attempt !== null || v.running || v.selectionDigest !== null) ||
        claim && result.admitted && (!v.tracked || !v.running || v.attempt === null)) fail('source_transfer_invalid_response');
    return structuredClone(result);
  }
  async claimAttempt(options) {
    const call = await this.#attemptChannel(options, Boolean(options.source));
    return this.#attemptView(await call('attempt/claim', { attemptId: options.attemptId, kind: options.kind,
      callDigest: options.callDigest, selectionDigest: options.selectionDigest ?? null }), true);
  }
  async releaseAttempt(options) {
    const call = await this.#attemptChannel(options);
    const result = await call('attempt/release', { attemptId: options.attemptId });
    if (!exact(result, ['released']) || typeof result.released !== 'boolean') fail('source_transfer_invalid_response');
    return result;
  }

  async cancelTarget({ requestId, target, commandId }) {
    if (!UUID.test(commandId)) fail('source_transfer_invalid_request');
    const call = await this.#recoverTarget(requestId, target);
    const active = this.#active.get(requestId);
    if (active) active.stopped = true;
    // A fixed-ID first cancellation is sent once. A lost reply is reconciled by readTarget.
    await call('cancel', { commandId });
    return targetProjection(requestId, targetSummary(await call('summary'), requestId), active?.finishing === true);
  }

  async resumeTarget({ requestId, target, expectedAdmissionControl, expectedOperationControl }) {
    const call = await this.#recoverTarget(requestId, target);
    const summary = targetSummary(await call('summary'), requestId);
    if (!expectedAdmissionControl || expectedOperationControl === undefined) fail('source_transfer_revision_conflict');
    const admission = state({ state: expectedAdmissionControl }), operation = state({ state: expectedOperationControl });
    if (hash(admission) !== hash(summary.admissionControl) || hash(operation) !== hash(summary.targetState)) {
      fail('source_transfer_revision_conflict');
    }
    await call('resume', { expectedAdmissionControl: admission, expectedOperationControl: operation });
    return targetProjection(requestId, targetSummary(await call('summary'), requestId));
  }

  async finishTarget({ requestId, target }) {
    if (this.#active.has(requestId)) fail('source_transfer_busy');
    const token = { stopped: false, finishing: false };
    this.#active.set(requestId, token);
    try {
      const call = await this.#recoverTarget(requestId, target);
      let summary = targetSummary(await call('summary'), requestId);
      if (summary.receipt || summary.workerRunning || summary.admissionControl?.cancelled || summary.targetState?.cancelled ||
          !summary.progress?.partsComplete || token.stopped) return targetProjection(requestId, summary);
      token.finishing = true;
      const saved = receipt(await call('finish'), requestId);
      token.finishing = false;
      summary = targetSummary(await call('summary'), requestId);
      if (!saved || hash(saved) !== hash(summary.receipt)) fail('source_transfer_invalid_response');
      return targetProjection(requestId, summary);
    } finally {
      if (this.#active.get(requestId) === token) this.#active.delete(requestId);
    }
  }

  async read({ requestId, source, target }) {
    const pair = await this.#pair(requestId, source, target);
    this.#bind(requestId, pair);
    const sourceState = state(await pair.sourceState());
    const targetState = state(await pair.target('state'));
    const saved = targetState?.ready ? receipt(await pair.target('receipt'), requestId) : null;
    if (targetState?.ready && !saved) fail('source_transfer_invalid_response');
    return projection(pair, { requestId, phase: saved ? 'ready' : 'pending', sourceState, targetState, receipt: saved });
  }

  async run({ requestId, source, target, selections: values, resume, signal, onProgress }) {
    let selected = values === undefined ? undefined : selections(values);
    if (this.#active.has(requestId)) fail('source_transfer_busy');
    const token = { stopped: false, finishing: false };
    this.#active.set(requestId, token);
    const check = () => { if (token.stopped || signal?.aborted) fail('source_transfer_interrupted'); };
    try {
      const pair = await this.#pair(requestId, source, target, check);
      this.#bind(requestId, pair, selected);
      let sourceState = state(await pair.sourceState());
      let targetState = state(await pair.target('state'));
      for (const role of ['source', 'target']) {
        const current = role === 'source' ? sourceState : targetState;
        const expected = resume?.[role];
        const needsResume = current?.cancelled || role === 'target' && pair.observation.targetAdmissionControl?.cancelled ||
          role === 'source' && (pair.observation.sourceSnapshotControl?.cancelled || ['failed', 'interrupted'].includes(pair.observation.sourceCapture.status));
        if (needsResume && (!expected || expected.sequence !== current?.sequence || expected.cancelWatermark !== current?.cancelWatermark ||
            role === 'source' && !Object.hasOwn(expected, 'snapshotControl') || role === 'target' && pair.observation.targetAdmissionControl &&
            (!expected.admissionControl || hash(state({ state: expected.admissionControl })) !== hash(pair.observation.targetAdmissionControl)))) {
          return projection(pair, { requestId, phase: 'pending', sourceState, targetState, receipt: null });
        }
      }
      for (const role of ['source', 'target']) {
        const current = role === 'source' ? sourceState : targetState;
        if (!current?.cancelled && !(role === 'target' && pair.observation.targetAdmissionControl?.cancelled) && !(role === 'source' && (pair.observation.sourceSnapshotControl?.cancelled ||
            ['failed', 'interrupted'].includes(pair.observation.sourceCapture.status)))) continue;
        const next = state(await pair[role]('resume', role === 'target' && pair.observation.targetAdmissionControl
          ? { expectedAdmissionControl: resume.target.admissionControl, expectedOperationControl: current }
          : { expectedSequence: current.sequence, expectedCancelWatermark: current.cancelWatermark,
            ...(role === 'source' ? { expectedSnapshotControl: resume.source.snapshotControl } : {}) }));
        if ((!next && current) || next?.cancelled) fail('source_transfer_invalid_response');
        if (role === 'source') sourceState = next; else targetState = next;
      }
      if (targetState?.ready) {
        const saved = receipt(await pair.target('receipt'), requestId);
        if (!saved) fail('source_transfer_invalid_response');
        return projection(pair, { requestId, phase: 'ready', sourceState, targetState, receipt: saved });
      }
      if (!selected) {
        if (!sourceState) fail('source_transfer_invalid_request');
        const result = await pair.source('intent');
        const saved = result?.intent;
        if (!exact(result, ['intent']) || !exact(saved, ['selections', 'selectionDigest']) ||
            saved.selectionDigest !== this.#bindings.get(requestId)?.selectionDigest) fail('source_transfer_invalid_response');
        selected = selections(saved.selections);
        this.#bind(requestId, pair, selected);
      }
      const grant = destination(await pair.target('grant'), requestId, pair.targetAuthority);
      // A new source selection is always checked through Native's stable intent
      // binding. A lost prepare reply stops this invocation instead of replay.
      if (selected.some(selection => selection.kind === 'projects') && (!source.supportsProjects() || !target.supportsProjects())) fail('source_transfer_projects_update_required');
      if (selected.some(selection => selection.kind === 'instructions') && (!source.supportsInstructions() || !target.supportsInstructions())) fail('source_transfer_scoped_instructions_update_required');
      sourceState = state(await pair.prepareSource({ destination: grant, selections: selected }));
      if (!sourceState) fail('source_transfer_invalid_response');
      if (sourceState.cancelled) return projection(pair, { requestId, phase: 'pending', sourceState, targetState, receipt: null });
      if (!sourceState.ready) {
        sourceState = state(await pair.source('capture'));
        while (sourceState && !sourceState.ready && !sourceState.cancelled && pair.observation.sourceCapture.status === 'running') {
          onProgress?.({ requestId, phase: 'capturing' });
          await this.wait(); check(); source.assertCurrent(); target.assertCurrent();
          sourceState = state(await pair.sourceState());
        }
      }
      // Older Native hosts can sample the checkpoint just before a short
      // capture completes and the worker just after it. Reconcile that terminal
      // observation once; never repeat capture or accept an unconfirmed payload.
      if (sourceState && !sourceState.ready && !sourceState.cancelled && pair.observation.sourceCapture.status === 'ready') {
        sourceState = state(await pair.sourceState());
      }
      if (!sourceState) fail('source_transfer_invalid_response');
      if (sourceState.cancelled || pair.observation.sourceSnapshotControl?.cancelled ||
          ['failed', 'interrupted'].includes(pair.observation.sourceCapture.status)) {
        return projection(pair, { requestId, phase: 'pending', sourceState, targetState, receipt: null });
      }
      if (!sourceState.ready) fail('source_transfer_invalid_response');
      const payload = manifest(await pair.source('manifest'), requestId, pair.sourceAuthority, grant);
      if (payload.value.entries.some(entry => Object.hasOwn(entry.content, 'uploadedSource')) && !target.supportsUploadedSource()) fail('source_transfer_uploaded_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'plugin_package' && Object.hasOwn(entry.content, 'uploadedSource')) && (!source.supportsUploadedPlugins() || !target.supportsUploadedPlugins())) fail('source_transfer_uploaded_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'work_asset' && Object.hasOwn(entry.content, 'sourceIdentity')) && !target.supportsAssetIdentity()) {
        fail('source_transfer_unsupported_native');
      }
      if (payload.value.entries.some(entry => entry.content.kind === 'project_inventory') && !target.supportsProjects()) fail('source_transfer_projects_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'instruction_bundle') && !target.supportsInstructions()) fail('source_transfer_scoped_instructions_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'plugin_package') && !target.supportsPlugins()) fail('source_transfer_plugins_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'work_asset' && ['agent', 'hook'].includes(entry.content.category)) && !target.supportsDefinitions()) fail('source_transfer_definitions_update_required');
      if (payload.value.entries.some(entry => entry.content.kind === 'work_asset' && entry.content.category === 'memory') && !target.supportsMemory()) {
        fail('source_transfer_memory_update_required');
      }
      if (!targetState) targetState = state(await pair.target('begin', { manifest: payload.value }));
      if (!targetState) fail('source_transfer_invalid_response');
      if (targetState.cancelled) return projection(pair, { requestId, phase: 'pending', sourceState, targetState, receipt: null });
      let acceptedBytes = 0;
      for (const entry of payload.value.entries) {
        let acknowledged = part(await pair.target('part/read', { entryId: entry.id }), entry, payload.digest);
        acceptedBytes += acknowledged.acceptedBytes;
        while (acknowledged.acceptedBytes < entry.bytes) {
          let pendingChunk = chunk(await pair.source('chunk', { entryId: entry.id, index: acknowledged.acceptedParts }),
            requestId, entry, acknowledged.acceptedParts, payload.digest);
          const previous = acknowledged;
          try { acknowledged = part(await pair.target('part/write', pendingChunk), entry, payload.digest); }
          finally { pendingChunk = null; }
          if (acknowledged.acceptedParts !== previous.acceptedParts + 1) fail('source_transfer_invalid_response');
          acceptedBytes += acknowledged.acceptedBytes - previous.acceptedBytes;
          onProgress?.({ requestId, phase: 'transferring', entries: payload.value.entries.length,
            totalBytes: payload.totalBytes, acceptedBytes });
        }
      }
      // A finish timeout is unknown, never a reason to blindly finish again.
      // Explicit run/read first checks the durable target receipt above.
      let finished;
      token.finishing = true;
      try { finished = await pair.target('finish'); } finally { token.finishing = false; }
      const saved = receipt(finished, requestId, payload);
      if (!saved) fail('source_transfer_invalid_response');
      targetState = state(await pair.target('state'));
      if (!targetState?.ready) fail('source_transfer_invalid_response');
      return projection(pair, { requestId, phase: 'ready', sourceState, targetState, receipt: saved });
    } finally {
      if (this.#active.get(requestId) === token) this.#active.delete(requestId);
    }
  }

  async cancel({ requestId, source, target, commandId }) {
    if (!UUID.test(commandId)) fail('source_transfer_invalid_request');
    const active = this.#active.get(requestId);
    if (active) active.stopped = true;
    const pair = await this.#pair(requestId, source, target);
    this.#bind(requestId, pair);
    // Dispatch both cancellations before awaiting either, so a slow source
    // cannot prevent cancellation of the independently owned target writer.
    const cancel = async role => {
      let current;
      try { current = state(await (role === 'target' ? pair.targetStateForCancel() : pair.source('state'))); }
      catch {
        // A failed observation cannot prevent the user's first fixed-ID cancel
        // from reaching its authenticated owner. This sends no replay: the
        // failed request was read-only and cancel has not yet been dispatched.
        return state(await pair[role]('cancel', { commandId }));
      }
      return current ? state(await pair[role]('cancel', { commandId })) : null;
    };
    const outcomes = await Promise.allSettled([cancel('source'), cancel('target')]);
    if (outcomes.some(outcome => outcome.status !== 'fulfilled')) fail('source_transfer_outcome_unknown');
    return projection(pair, { requestId, phase: 'pending', sourceState: outcomes[0].value, targetState: outcomes[1].value, receipt: null });
  }
}

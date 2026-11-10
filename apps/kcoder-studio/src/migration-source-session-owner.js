import { PROJECT_SOURCE_METHODS, validProjectSourceCall } from './migration-project-query.js';
import { isContract } from '../shared/generated/validator.mjs';
import { INSTRUCTION_CAPABILITY, INSTRUCTION_METHODS, validInstructionSourceCall } from '../shared/migrationInstructions.mjs';
import { captureMigrationSourceScope, captureMigrationSourceEndpoint } from './migration-source-bridge.js';
import { createMigrationSourceSessionLauncher, terminateMigrationSourceSessionChild } from './migration-source-session-launch.js';
import { MIGRATION_SOURCE_INTERNAL_CAPABILITY, MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY,
  MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY, MIGRATION_SOURCE_INTERNAL_PREFIX, MigrationSourceBridgeError } from './migration-source-private.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DISCOVERY = new Set([...Object.values(PROJECT_SOURCE_METHODS), ...Object.values(INSTRUCTION_METHODS), 'migration/plugin/discover', 'migration/definitions/discover', 'migration/configuration/layers', 'migration/discover', 'migration/history/discover', 'migration/history/families/discover', 'migration/history/sources', 'migration/source/bindings', 'migration/codex/layers/select', 'migration/codex/layers/read', 'migration/source/directory/select', 'migration/source/upload/select', 'migration/memory/discover', 'migration/memory/sources']);
const RECOVERY = new Set(['peer/recover-target', 'target/state', 'target/summary', 'target/receipt', 'target/cancel', 'target/resume', 'target/finish',
  'target/attempt/read', 'target/attempt/claim', 'target/attempt/release',
  'target/received/read', 'target/adoption/prepare', 'target/adoption/read', 'target/adoption/resume', 'target/adoption/cancel',
  'target/private/candidates', 'target/private/read', 'target/private/accept', 'target/private/cancel', 'target/private/resume', 'target/private/prepare-status', 'target/private/prepare', 'target/private/release']);
const fail = reason => { throw new MigrationSourceBridgeError(reason); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const done = resource => resource.closed === true;
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

/** One record owns at most a probe and its replacement child. It is never put
 * into the normal shared workspace pool or adopted by a different operation. */
export class MigrationSourceSessionOwner {
  #records = new Map();
  #closed = false;

  constructor({ launch = createMigrationSourceSessionLauncher(), terminate = terminateMigrationSourceSessionChild,
    maxSessions = 8, initializeTimeoutMs = 10_000, cleanupTimeoutMs = 2_000 } = {}) {
    if (typeof launch !== 'function' || typeof terminate !== 'function' || !Number.isSafeInteger(maxSessions) ||
        maxSessions < 1 || maxSessions > 64 || !Number.isSafeInteger(initializeTimeoutMs) ||
        initializeTimeoutMs < 1 || initializeTimeoutMs > 30_000 || !Number.isSafeInteger(cleanupTimeoutMs) ||
        cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000) fail('source_transfer_invalid_request');
    this.launch = launch; this.terminate = terminate;
    this.maxSessions = maxSessions; this.initializeTimeoutMs = initializeTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
  }

  #assert(record) {
    if (record.revoked || this.#closed) fail('source_transfer_authority_changed');
    try { record.fence.assertCurrent(); }
    catch {
      this.#revoke(record); void this.#cleanup(record);
      fail('source_transfer_authority_changed');
    }
  }

  #adopt(record, resource) {
    if (!resource?.child || typeof resource.child.once !== 'function') fail('source_transfer_invalid_launch');
    if (record.resources.has(resource)) return resource;
    // A child belongs to exactly one record even when an injected launcher is buggy.
    for (const other of this.#records.values()) {
      if (other !== record && [...other.resources].some(owned => owned.child === resource.child)) {
        fail('source_transfer_owned_child_conflict');
      }
    }
    resource.closed = done(resource) === true;
    record.resources.add(resource);
    resource.child.once('close', () => {
      resource.closed = true;
      record.resources.delete(resource);
      if (!resource.stopping && !record.revoked) this.#revoke(record);
      this.#forget(record);
    });
    if (record.revoked) {
      // Adoption can race a cleanup pass that sampled an empty resource set.
      // Chain after that pass rather than losing the late handle or busy retrying.
      Promise.resolve(record.cleaning).then(() => this.#cleanup(record)).catch(() => {});
    }
    return resource;
  }

  async #launch(record, phase, supported = false) {
    this.#assert(record);
    record.launching++;
    try {
      const resource = await this.launch({ target: record.target, workspacePath: record.workspacePath, phase,
        purpose: record.purpose, parentLaunchSupported: supported, adopt: value => this.#adopt(record, value),
        capturedScope: record.fence.captured,
        assertCurrent: () => this.#assert(record) });
      this.#adopt(record, resource);
      this.#assert(record);
      if (!resource.broker || resource.broker.child === undefined || resource.broker.closed || done(resource) ||
          resource.child.exitCode !== null && resource.child.exitCode !== undefined) {
        fail('source_transfer_invalid_launch');
      }
      return resource;
    } finally {
      record.launching--;
      if (record.revoked) void this.#cleanup(record);
    }
  }

  async #rpc(record, resource, method, params) {
    this.#assert(record);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new MigrationSourceBridgeError('source_transfer_outcome_unknown')), this.initializeTimeoutMs);
      const settle = value => { clearTimeout(timer); resolve(value); };
      try { resource.broker.sendInternalRequest(method, params, { onResponse: settle }); }
      catch { clearTimeout(timer); reject(new MigrationSourceBridgeError('source_transfer_outcome_unknown')); }
    });
    this.#assert(record);
    if (method === 'migration/source/directory/select' && result?.error) {
      const reasons = {
        migration_unsafe_selected_root: 'source_transfer_directory_invalid',
        migration_selected_root_unavailable: 'source_transfer_directory_unavailable',
        migration_selected_root_changed: 'source_transfer_directory_changed',
        migration_selected_root_expired: 'source_transfer_directory_expired',
        migration_selected_root_scope_changed: 'source_transfer_directory_conflict',
        migration_selected_root_selection_changed: 'source_transfer_directory_conflict',
        migration_selected_root_already_discovered: 'source_transfer_directory_in_use',
      };
      if (typeof result.error.message === 'string' && Object.hasOwn(reasons, result.error.message)) fail(reasons[result.error.message]);
    }
    if (method === 'migration/source/upload/select' && result?.error) {
      const reasons = { source_upload_not_ready: 'source_transfer_uploaded_not_ready',
        source_upload_manifest_changed: 'source_transfer_uploaded_changed', source_upload_product_not_ready: 'source_transfer_uploaded_not_ready',
        source_upload_product_selection_conflict: 'source_transfer_uploaded_conflict', source_upload_product_selection_in_use: 'source_transfer_uploaded_in_use',
        migration_selected_root_expired: 'source_transfer_uploaded_expired' };
      if (typeof result.error.message === 'string' && Object.hasOwn(reasons, result.error.message)) fail(reasons[result.error.message]);
    }
    if (['migration/history/families/discover', 'migration/history/sources'].includes(method) && result?.error) {
      const reasons = {
        history_discovery_family_metadata_changed: 'source_transfer_history_catalog_unavailable',
        history_discovery_catalog_unavailable: 'source_transfer_history_catalog_unavailable',
        history_discovery_expired: 'source_transfer_catalog_expired',
      };
      const code = result.error.message;
      if (typeof code === 'string' && Object.hasOwn(reasons, code)) fail(reasons[code]);
    }
    if (Object.values(PROJECT_SOURCE_METHODS).includes(method) && result?.error) {
      const reasons = { migration_project_source_changed: 'source_transfer_project_catalog_unavailable',
        migration_project_catalog_unavailable: 'source_transfer_project_catalog_unavailable',
        migration_project_catalog_expired: 'source_transfer_catalog_expired',
        migration_project_source_cancelled: 'source_transfer_project_cancelled' };
      if (Object.hasOwn(reasons, result.error.message)) fail(reasons[result.error.message]);
    }
    if (Object.values(INSTRUCTION_METHODS).includes(method) && result?.error) {
      const code = result.error.message;
      const known = ['migration_instruction_capture_changed', 'migration_instruction_capture_capacity', 'migration_instruction_capture_expired', 'migration_instruction_capture_unavailable', 'migration_instruction_capture_owner_changed', 'migration_instruction_root_untrusted', 'migration_instruction_root_changed', 'migration_instruction_root_unavailable', 'migration_instruction_root_unsafe', 'migration_instruction_root_invalid', 'migration_instruction_source_changed', 'migration_instruction_source_budget_exceeded', 'migration_instruction_source_workspace_changed', 'migration_instruction_uploaded_root_unsupported', 'migration_instruction_path_outside_grant', 'migration_instruction_cwd_outside_grant', 'migration_instruction_semantics_require_review', 'migration_instruction_encoding_requires_review', 'migration_instruction_import_budget_requires_review', 'migration_instruction_import_cycle_requires_review', 'migration_instruction_import_encoding_requires_review', 'migration_instruction_import_path_requires_review', 'migration_instruction_import_semantics_require_review', 'migration_instruction_import_unavailable'];
      if (known.includes(code)) fail(`source_transfer_${code.slice('migration_'.length)}`);
      const other = { migration_cancelled: 'source_transfer_instruction_cancelled', migration_invalid_page: 'source_transfer_instruction_invalid_page', migration_unknown_item: 'source_transfer_instruction_unknown_item' };
      if (Object.hasOwn(other, code)) fail(other[code]);
    }
    if (result?.error || !Object.hasOwn(result ?? {}, 'result')) fail('source_transfer_outcome_unknown');
    return result.result;
  }

  async #initialize(record, resource) {
    const result = await this.#rpc(record, resource, 'initialize', {
      protocolVersion: '2026-07-27', clientInfo: { name: 'kcoder-migration-session-owner', version: '1' },
    });
    this.#assert(record);
    if (!result?.capabilities?.experimental) fail('source_transfer_unsupported_native');
    return result.capabilities.experimental;
  }

  async #start(record) {
    try {
      let current = await this.#launch(record, 'probe');
      let capabilities = await this.#initialize(record, current);
      const managed = record.target.security !== undefined;
      if (!managed) {
        if (capabilities[MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY] !== true) fail('source_transfer_unsupported_native');
        this.#assert(record);
        await this.#stop(record, current);
        this.#assert(record);
        if (!done(current)) fail('source_transfer_cleanup_unconfirmed');
        current = await this.#launch(record, 'migration', true);
        capabilities = await this.#initialize(record, current);
      }
      if (capabilities[MIGRATION_SOURCE_INTERNAL_CAPABILITY] !== true ||
          record.purpose === 'target-recovery' && capabilities[MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY] !== true) {
        fail('source_transfer_authority_unavailable');
      }
      this.#assert(record);
      record.current = current;
      const guarded = {
        get closed() { return record.revoked || current.broker.closed; },
        get initializeResponse() { return current.broker.initializeResponse; },
        sendMigrationSourceRequest: (method, params, proof) => {
          this.#assert(record);
          const suffix = method.startsWith(MIGRATION_SOURCE_INTERNAL_PREFIX) ? method.slice(MIGRATION_SOURCE_INTERNAL_PREFIX.length) : '';
          const allowed = record.purpose === 'target-recovery' ? RECOVERY.has(suffix)
            : suffix === 'identity' || suffix === 'peer/accept' || record.purpose === 'target' && suffix === 'peer/recover-target' || suffix.startsWith(record.purpose + '/');
          if (!allowed) fail('source_transfer_role_mismatch');
          return current.broker.sendMigrationSourceRequest(method, params, proof);
        },
      };
      const endpoint = captureMigrationSourceEndpoint({ broker: guarded,
        captureCurrent: () => { this.#assert(record); return record.fence.captured; } });
      record.state = 'ready';
      return Object.freeze({ captured: record.fence.captured, endpoint,
        assertCurrent: () => this.#assert(record),
        request: async (method, params = {}) => {
          if (record.purpose !== 'source' || !DISCOVERY.has(method)) fail('source_transfer_method_unavailable');
          if (method === 'migration/history/families/discover' && capabilities.migrationHistoryFamilyIndexV1 !== true) fail('source_transfer_unsupported_native');
          if (method === 'migration/history/families/discover' && (!isContract('MigrationHistoryDiscoverParams', params) || params.source !== 'codex')) fail('source_transfer_invalid_request');
          if (method === 'migration/configuration/layers' && (capabilities.migrationSourceConfigurationLayersV1 !== true || capabilities.migrationConfigurationLayersV1 !== true)) fail('source_transfer_configuration_layers_update_required');
          if (method === 'migration/configuration/layers' && (!isContract('MigrationConfigurationLayersParams', params) || params.target.kind !== 'source')) fail('source_transfer_invalid_request');
          if (method === 'migration/source/bindings' && capabilities.migrationSourceBindingsV1 !== true) fail('source_transfer_source_bindings_update_required');
          if (method === 'migration/source/upload/select' && capabilities.migrationSourceUploadedV1 !== true) fail('source_transfer_uploaded_update_required');
          if (method === 'migration/source/directory/select' && capabilities.migrationSourceDirectoryV1 !== true) fail('source_transfer_directory_update_required');
          if (method === 'migration/plugin/discover' && (capabilities.migrationLocalPluginsV1 !== true || capabilities.migrationSourceTransferPluginsV1 !== true)) fail('source_transfer_plugins_update_required');
          if (method === 'migration/plugin/discover' && params.includeProject === true && capabilities.migrationPluginProjectsV1 !== true) fail('source_transfer_plugin_projects_update_required');
          if (method === 'migration/plugin/discover' && params.includeUploaded === true && capabilities.migrationSourceUploadedPluginsV1 !== true) fail('source_transfer_uploaded_update_required');
          if (method === 'migration/definitions/discover' && capabilities.migrationDefinitionsV1 !== true) fail('source_transfer_definitions_update_required');
          if (method.startsWith('migration/memory/') && capabilities.migrationMemoryV1 !== true) fail('source_transfer_memory_update_required');
          if (method.startsWith('migration/codex/layers/') && capabilities.migrationSourceCodexLayersV1 !== true) fail('source_transfer_codex_layers_update_required');
          if (Object.values(PROJECT_SOURCE_METHODS).includes(method)) {
            if (capabilities.migrationProjectsV1 !== true) fail('source_transfer_projects_update_required');
            if (!validProjectSourceCall(method, params)) fail('source_transfer_invalid_request');
            const result = await this.#rpc(record, current, method, params);
            if (!validProjectSourceCall(method, params, result)) fail('source_transfer_invalid_response');
            return result;
          }
          if (Object.values(INSTRUCTION_METHODS).includes(method)) {
            if (capabilities[INSTRUCTION_CAPABILITY] !== true) fail('source_transfer_instructions_update_required');
            if (!validInstructionSourceCall(method, params)) fail('source_transfer_invalid_request');
            const result = await this.#rpc(record, current, method, params);
            if (!validInstructionSourceCall(method, params, result)) fail('source_transfer_invalid_response');
            return result;
          }
          return this.#rpc(record, current, method, params);
        },
        release: () => this.#release(record),
      });
    } catch (error) {
      this.#revoke(record, false);
      await this.#cleanup(record);
      if (error instanceof MigrationSourceBridgeError) throw error;
      fail('source_transfer_launch_unconfirmed');
    }
  }

  open({ sessionId, purpose, target, workspacePath, captureCurrent, signal }) {
    if (this.#closed || !UUID.test(sessionId) || !['source', 'target', 'target-recovery'].includes(purpose) ||
        target?.runtime !== 'kcoder' || !['local', 'ssh'].includes(target.transport) || signal?.aborted) {
      return Promise.reject(new MigrationSourceBridgeError('source_transfer_invalid_request'));
    }
    let fence, snapshot;
    try { fence = captureMigrationSourceScope(captureCurrent); snapshot = freeze(structuredClone(target)); }
    catch { return Promise.reject(new MigrationSourceBridgeError('source_transfer_authority_unavailable')); }
    const key = sessionId + '/' + purpose;
    const old = this.#records.get(key);
    if (old) {
      if (old.revoked || !same(old.fence.captured, fence.captured) || old.workspacePath !== workspacePath || !same(old.target, snapshot)) {
        return Promise.reject(new MigrationSourceBridgeError('source_transfer_session_conflict'));
      }
      return old.opening;
    }
    if (this.#records.size >= this.maxSessions) return Promise.reject(new MigrationSourceBridgeError('source_transfer_session_limit'));
    let revoked;
    const cancellation = new Promise((_, reject) => { revoked = reject; });
    const record = { key, purpose, target: snapshot, workspacePath, fence, resources: new Set(), launching: 0,
      current: null, state: 'opening', revoked: false, reject: revoked, signal };
    this.#records.set(key, record);
    record.abort = () => { void this.#release(record); };
    signal?.addEventListener('abort', record.abort, { once: true });
    record.task = this.#start(record);
    record.opening = Promise.race([record.task, cancellation]);
    // Late launches still finish ownership cleanup after the public open has rejected.
    record.task.catch(() => {});
    return record.opening;
  }

  #revoke(record, notify = true) {
    if (record.revoked) return;
    record.revoked = true; record.state = 'closing';
    record.signal?.removeEventListener('abort', record.abort);
    if (notify) record.reject(new MigrationSourceBridgeError('source_transfer_authority_changed'));
  }
  #forget(record) {
    if (record.revoked && record.launching === 0 && record.resources.size === 0 && this.#records.get(record.key) === record) {
      this.#records.delete(record.key);
    }
  }
  async #stop(record, resource) {
    if (done(resource)) { record.resources.delete(resource); return; }
    if (!resource.stopping) resource.stopping = Promise.resolve().then(() => this.terminate(resource)).catch(() => null);
    const stopping = resource.stopping;
    let timer;
    try {
      await Promise.race([stopping, new Promise(resolve => { timer = setTimeout(resolve, this.cleanupTimeoutMs); })]);
    } finally { clearTimeout(timer); }
    stopping.then(() => { if (resource.stopping === stopping) resource.stopping = null; });
    if (done(resource)) record.resources.delete(resource);
    this.#forget(record);
  }
  async #cleanup(record) {
    if (record.cleaning) return record.cleaning;
    record.cleaning = (async () => {
      await Promise.allSettled([...record.resources].map(resource => this.#stop(record, resource)));
      this.#forget(record);
      return { status: record.resources.size ? 'unknown' : record.launching ? 'pending' : 'released' };
    })();
    try { return await record.cleaning; } finally { record.cleaning = null; }
  }
  #release(record) { this.#revoke(record); return this.#cleanup(record); }
  #selected({ sessionId, purpose, captureCurrent, target, workspacePath }) {
    if (!UUID.test(sessionId) || !['source', 'target', 'target-recovery'].includes(purpose)) fail('source_transfer_invalid_request');
    const current = captureMigrationSourceScope(captureCurrent);
    const records = [...this.#records.values()].filter(record => record.key === sessionId + '/' + purpose);
    if (records.some(record => !same(record.fence.captured, current.captured))) fail('source_transfer_authority_changed');
    if (target !== undefined && records.some(record => !same(record.target, target) || record.workspacePath !== workspacePath)) {
      fail('source_transfer_session_conflict');
    }
    return records;
  }
  read(options) {
    const record = this.#selected(options)[0];
    return record ? { status: record.state, launching: record.launching > 0, ownedChildren: record.resources.size }
      : { status: 'released', launching: false, ownedChildren: 0 };
  }
  async request(options, method, params = {}) {
    const lease = await this.existingLease(options);
    return lease.request(method, params);
  }
  async existingLease(options) {
    const record = this.#selected(options)[0];
    if (!record || record.revoked || record.state !== 'ready') fail('source_transfer_session_unavailable');
    this.#assert(record);
    const lease = await record.opening;
    if (this.#selected(options)[0] !== record || record.revoked || record.state !== 'ready') {
      fail('source_transfer_session_unavailable');
    }
    this.#assert(record);
    return lease;
  }
  async existingEndpoint(options) {
    return (await this.existingLease(options)).endpoint;
  }
  async release(options) {
    const records = this.#selected(options);
    const results = await Promise.all(records.map(record => this.#release(record)));
    return { status: results.some(value => value.status === 'unknown') ? 'unknown' : results.some(value => value.status === 'pending') ? 'pending' : 'released' };
  }
  async close() {
    this.#closed = true;
    return { results: await Promise.all([...this.#records.values()].map(record => this.#release(record))) };
  }
  async sweep() {
    const invalid = [...this.#records.values()].filter(record => {
      if (record.revoked) return true;
      try { record.fence.assertCurrent(); return false; } catch { return true; }
    });
    return { results: await Promise.all(invalid.map(record => this.#release(record))) };
  }
  get size() { return this.#records.size; }
}

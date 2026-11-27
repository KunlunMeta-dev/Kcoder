import { validPrivatePreparationResult } from './migration-source-credential-preparation.js';
import { privateCredentialOfferSet, validPrivateCredentialOfferSet } from './migration-source-credential-bundles.js';
import { validPrivateCandidatePlanInput, validPrivateCandidateResult } from './migration-source-credential-candidates.js';
import { isContract } from '../shared/generated/validator.mjs';
import { MigrationSourceBridgeError } from './migration-source-private.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = reason => { throw new MigrationSourceBridgeError(reason); };
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
const same = (left, right) => canonical(left) === canonical(right);
const atom = (value, limit = 256) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= limit && !/[\p{Cc}]/u.test(value);

function consent(value) {
  if (!exact(value, ['apiKeys', 'mcpPrivateFields']) || typeof value.apiKeys !== 'boolean'
    || typeof value.mcpPrivateFields !== 'boolean') fail('private_credentials_invalid_request');
  return { apiKeys: value.apiKeys, mcpPrivateFields: value.mcpPrivateFields };
}
function selections(values, approved) {
  if (!Array.isArray(values) || !values.length || values.length > 64) fail('private_credentials_invalid_request');
  const seen = new Set();
  return values.map(item => {
    const keys = item?.kind === 'provider' ? ['kind', 'sourceName', 'selector', 'targetName', 'endpoint', 'apiFormat']
      : ['kind', 'sourceName', 'fields', 'targetName', 'definitionSha256'];
    if (!exact(item, keys) || !atom(item.sourceName) || !atom(item.targetName)) fail('private_credentials_invalid_request');
    const key = `${item.kind}\0${item.targetName}`;
    if (seen.has(key)) fail('private_credentials_invalid_request');
    seen.add(key);
    if (item.kind === 'provider') {
      if (!approved.apiKeys) fail('private_credentials_explicit_consent_required');
      if (!atom(item.endpoint, 8192) || !atom(item.apiFormat, 64) || !(exact(item.selector, ['kind'])
        && item.selector.kind === 'claude_configuration') && !(exact(item.selector, ['kind', 'variable'])
        && item.selector.kind === 'environment' && /^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(item.selector.variable))) {
        fail('private_credentials_invalid_request');
      }
      return { kind: 'provider', source_name: item.sourceName, selector: structuredClone(item.selector),
        target_name: item.targetName, endpoint: item.endpoint, api_format: item.apiFormat };
    }
    if (item.kind !== 'mcp' || !SHA.test(item.definitionSha256) || !Array.isArray(item.fields)
      || !item.fields.length || item.fields.length > 32 || item.fields.some(field => !exact(field, ['kind', 'name'])
        || !['environment', 'header'].includes(field.kind) || !atom(field.name, 128)
        || field.kind === 'environment' && !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(field.name)
        || field.kind === 'header' && !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(field.name))
      || new Set(item.fields.map(canonical)).size !== item.fields.length) fail('private_credentials_invalid_request');
    if (!approved.mcpPrivateFields) fail('private_credentials_explicit_consent_required');
    return { kind: 'mcp', source_name: item.sourceName, fields: structuredClone(item.fields).sort((a, b) =>
      a.kind === b.kind ? a.name < b.name ? -1 : a.name > b.name ? 1 : 0 : a.kind === 'environment' ? -1 : 1),
      target_name: item.targetName, definition_sha256: item.definitionSha256 };
  });
}
function locator(options) {
  if (!UUID.test(options?.requestId) || !UUID.test(options?.offerId)) fail('private_credentials_invalid_request');
  // These fields are always Native-owned, including on an authenticated public request.
  for (const key of ['offer', 'publicKey', 'envelope', 'ciphertext', 'authority', 'sourceAuthority', 'targetAuthority', 'peerRef']) {
    if (Object.hasOwn(options, key)) fail('private_credentials_invalid_request');
  }
}
function control(value) {
  if (!exact(value, ['sequence', 'cancelWatermark', 'cancelled', 'ready']) || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0 || !Number.isSafeInteger(value.cancelWatermark) || value.cancelWatermark < 0
    || typeof value.cancelled !== 'boolean' || typeof value.ready !== 'boolean') fail('private_credentials_invalid_response');
  return structuredClone(value);
}
function custody(value, options, expectedOffer) {
  if (!exact(value, ['offer', 'envelope', 'control', 'writerRunning', 'received', 'keyReleased'])
    || typeof value.writerRunning !== 'boolean' || typeof value.received !== 'boolean'
    || typeof value.keyReleased !== 'boolean') fail('private_credentials_invalid_response');
  const offer = value.offer;
  if (!exact(offer, ['context', 'suite', 'publicKey']) || offer.suite !== 'hpke-x25519-hkdf-sha256-aes256gcm-v1'
    || !/^[A-Za-z0-9+/]{43}=$/.test(offer.publicKey) || offer.context?.requestId !== options.requestId
    || offer.context?.offerId !== options.offerId || expectedOffer && !same(offer, expectedOffer)) {
    fail('private_credentials_invalid_response');
  }
  if (value.envelope !== null && (!exact(value.envelope, ['version', 'offerId', 'offerSha256', 'encapsulatedKey', 'ciphertext'])
    || value.envelope.version !== 1 || value.envelope.offerId !== options.offerId || !SHA.test(value.envelope.offerSha256)
    || !atom(value.envelope.encapsulatedKey, 128) || !atom(value.envelope.ciphertext, 710000))) fail('private_credentials_invalid_response');
  return { ...value, control: control(value.control) };
}
function publicView(options, source, target) {
  const running = source?.writerRunning || target?.writerRunning || false;
  const cancelled = source?.control.cancelled || target?.control.cancelled || false;
  return { requestId: options.requestId, offerId: options.offerId,
    phase: cancelled ? running ? 'cancelling' : 'cancelled' : running ? 'running' : target?.keyReleased ? 'released'
      : target?.received ? 'received' : source?.envelope ? 'sealed' : 'offered',
    sourceControl: source?.control ?? null, targetControl: target?.control ?? null,
    sourceObserved: source !== null, targetObserved: target !== null,
    sourceWorkerRunning: source?.writerRunning ?? null, targetWorkerRunning: target?.writerRunning ?? null,
    received: target?.received ?? false, keyReleased: target?.keyReleased ?? false };
}

/** Trusted composition only. The authenticated Gateway/launcher is inside the
 * trust boundary; HPKE base mode does not resist a compromised relay replacing
 * a key. Public clients never provide a key, offer, authority or ciphertext. */
export class MigrationSourceCredentialsBridge {
  #open;
  #active = new Set();
  #openSource;
  constructor({ transferBridge, openChannel, openSourceChannel } = {}) {
    this.#openSource = openSourceChannel ?? (typeof transferBridge?.privateCredentialSourceChannel === 'function' ? options => transferBridge.privateCredentialSourceChannel(options) : null);
    this.#open = openChannel ?? (options => transferBridge.privateCredentialsChannel(options));
    if (!openChannel && typeof transferBridge?.privateCredentialsChannel !== 'function') fail('private_credentials_unavailable');
  }
  async #channel(options, targetOnly = false, requireBundles = false) {
    locator(options);
    const channel = await this.#open({ requestId: options.requestId, target: options.target,
      ...(targetOnly ? {} : { source: options.source }), ...(requireBundles ? { requireBundles: true } : {}) });
    channel.assertCurrent();
    return channel;
  }
  async #call(channel, side, operation, params) {
    channel.assertCurrent();
    let value;
    try { value = await channel[side](`private/${operation}`, params); }
    catch (error) {
      channel.assertCurrent();
      if (error instanceof MigrationSourceBridgeError && isContract('MigrationSourceCredentialError', error.reason)) throw error;
      fail('private_credentials_outcome_unknown');
    }
    channel.assertCurrent();
    return value;
  }
  async preparationStatus(options) {
    if (!UUID.test(options.requestId) || !/^mig-[0-9a-f]{32}$/.test(options.jobId)) fail('private_credentials_invalid_request');
    const channel = await this.#open({ requestId: options.requestId, target: options.target, requirePreparations: true });
    const value = await this.#call(channel, 'target', 'prepare-status', { jobId: options.jobId });
    if (!validPrivatePreparationResult(options, value)) fail('private_credentials_invalid_response');
    return structuredClone(value);
  }
  async candidates(options) {
    if (!UUID.test(options.requestId) || !SHA.test(options.manifestSha256) || !/^e\d{4}-\d{4}$/.test(options.entryId)
      || !Number.isSafeInteger(options.pageIndex) || options.pageIndex < 0 || options.pageIndex > 1024 || !validPrivateCandidatePlanInput(options)) fail('private_credentials_invalid_request');
    const channel = await this.#open({ requestId: options.requestId, target: options.target });
    const value = await this.#call(channel, 'target', 'candidates', { manifestSha256: options.manifestSha256,
      entryId: options.entryId, pageIndex: options.pageIndex,
      ...(options.jobId != null ? { jobId: options.jobId, expectedPlanId: options.expectedPlanId } : {}) });
    if (!validPrivateCandidateResult(options, value)) fail('private_credentials_invalid_response');
    return structuredClone(value);
  }
  async run(options) {
    locator(options);
    if (!SHA.test(options.manifestSha256) || !/^e\d{4}-\d{4}$/.test(options.entryId)) fail('private_credentials_invalid_request');
    const approved = consent(options.consent), selected = selections(options.selections, approved);
    if (this.#active.has(options.offerId) || this.#active.size >= 2) fail('private_credentials_busy');
    this.#active.add(options.offerId);
    try {
      const channel = await this.#channel(options);
      const target = custody(await this.#call(channel, 'target', 'offer', {
        offerId: options.offerId, manifestSha256: options.manifestSha256, entryId: options.entryId,
        selections: selected, consent: approved,
      }), options);
      if (target.offer.context.manifestSha256 !== options.manifestSha256 || target.offer.context.entryId !== options.entryId
        || !same(target.offer.context.selections, selected)) fail('private_credentials_binding_changed');
      if (target.control.cancelled || target.received || target.keyReleased) return publicView(options, null, target);
      // Forward exactly the Native target's original offer, never a public key parameter.
      const source = custody(await this.#call(channel, 'source', 'seal', { offer: target.offer, consent: approved }), options, target.offer);
      if (source.control.cancelled || !source.envelope) return publicView(options, source, target);
      const accepted = custody(await this.#call(channel, 'target', 'accept', {
        offerId: options.offerId, envelope: source.envelope, consent: approved,
      }), options, target.offer);
      return publicView(options, source, accepted);
    } finally { this.#active.delete(options.offerId); }
  }
  async sourceRead(options) {
    locator(options);
    if (!this.#openSource) fail('private_credentials_unavailable');
    const channel = await this.#openSource({ requestId: options.requestId, source: options.source });
    const value = await this.#call(channel, 'source', 'observe', { offerId: options.offerId });
    if (!exact(value, ['control', 'writerRunning']) || typeof value.writerRunning !== 'boolean') fail('private_credentials_invalid_response');
    const state = control(value.control);
    return { requestId: options.requestId, offerId: options.offerId,
      phase: state.cancelled ? value.writerRunning ? 'cancelling' : 'cancelled' : value.writerRunning ? 'running' : state.ready ? 'sealed' : 'offered',
      sourceControl: state, targetControl: null, sourceObserved: true, targetObserved: false,
      sourceWorkerRunning: value.writerRunning, targetWorkerRunning: null, received: false, keyReleased: false };
  }
  async read(options) {
    const channel = await this.#channel(options, true);
    const target = custody(await this.#call(channel, 'target', 'read', { offerId: options.offerId }), options);
    return publicView(options, null, target);
  }
  async control(options, operation) {
    if (!['cancel', 'resume'].includes(operation)) fail('private_credentials_invalid_request');
    const side = options.side;
    if (!['source', 'target'].includes(side)) fail('private_credentials_invalid_request');
    const channel = await this.#channel(options, side === 'target');
    const payload = { offerId: options.offerId };
    if (operation === 'cancel') {
      if (!UUID.test(options.commandId)) fail('private_credentials_invalid_request');
      payload.commandId = options.commandId;
    } else {
      const expected = options.expectedControl;
      if (!exact(expected, ['sequence', 'cancelWatermark']) || !Number.isSafeInteger(expected.sequence) || expected.sequence < 0
        || !Number.isSafeInteger(expected.cancelWatermark) || expected.cancelWatermark < 0) fail('private_credentials_invalid_request');
      Object.assign(payload, { expectedSequence: expected.sequence, cancelWatermark: expected.cancelWatermark });
    }
    const result = await this.#call(channel, side, operation, payload);
    const watermark = result?.control;
    if (!exact(result, ['control', 'writerRunning']) || typeof result.writerRunning !== 'boolean'
      || !exact(watermark, ['sequence', 'cancelWatermark', 'cancelled'])
      || !Number.isSafeInteger(watermark.sequence) || watermark.sequence < 0
      || !Number.isSafeInteger(watermark.cancelWatermark) || watermark.cancelWatermark < 0
      || typeof watermark.cancelled !== 'boolean') fail('private_credentials_invalid_response');
    return { requestId: options.requestId, offerId: options.offerId, side,
      control: structuredClone(watermark), workerRunning: result.writerRunning };
  }
  async prepare(options) {
    if (!atom(options.jobId) || !Number.isSafeInteger(options.expectedSequence) || options.expectedSequence < 0) fail('private_credentials_invalid_request');
    const offerIds = privateCredentialOfferSet(options);
    const approved = consent(options.consent), channel = await this.#channel(options, true, offerIds !== null);
    if (offerIds && channel.supportsBundles !== true) fail('private_credentials_update_required');
    const result = await this.#call(channel, 'target', 'prepare', { offerId: options.offerId, jobId: options.jobId,
      expectedSequence: options.expectedSequence, consent: approved,
      ...(offerIds ? { additionalOffers: offerIds.filter(value => value !== options.offerId) } : {}) });
    if (!exact(result, offerIds ? ['job', 'offerIds'] : ['job']) || !isContract('MigrationJobReadResult', result.job)
      || result.job.job.jobId !== options.jobId || offerIds && !validPrivateCredentialOfferSet(offerIds, result.offerIds)) fail('private_credentials_invalid_response');
    return { requestId: options.requestId, offerId: options.offerId, job: structuredClone(result.job),
      ...(offerIds ? { offerIds: [...result.offerIds] } : {}) };
  }
  async release(options) {
    if (!(options.jobId === null || atom(options.jobId))) fail('private_credentials_invalid_request');
    const channel = await this.#channel(options, true);
    const result = custody(await this.#call(channel, 'target', 'release', { offerId: options.offerId, jobId: options.jobId }), options);
    return publicView(options, null, result);
  }
}

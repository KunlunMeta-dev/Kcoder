import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { configurationPublicationFailure } from './server-mutation.mjs';

const targetId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const connectionFingerprint = value => { const { label: _label, labelKey: _labelKey, description: _description, ...connection } = value; return fingerprint(connection); };
const closedError = code => Object.assign(new Error(code), { code });

/** Only the composition root supplies the held Native image verifier. A
 * request can select an existing source, but cannot supply a program or path.
 */
export function createCurrentInstallationRecovery({ storePath, getServers, currentProgram, normalize, project,
  signature, serialize, publish, authorize, sameOrigin, readBody, respond, now = Date.now,
  makeId = randomUUID }) {
  const drafts = new Map();
  function prepare(sourceId, owner) {
    if (!storePath || !targetId(sourceId)) return null;
    const servers = getServers(), source = servers.find(server => server.id === sourceId);
    if (!source || source.transport !== 'local' || source.security) return null;
    const program = currentProgram();
    if (!program || typeof program.command !== 'string') return null;
    const original = project(source);
    const key = fingerprint([sourceId, signature(source), program.command, source.cwd]);
    const id = `current-${key.slice(0, 16)}`;
    const existing = servers.find(server => server.id === id);
    const candidate = normalize({ id, label: source.label, runtime: 'kcoder', transport: 'local', command: program.command, workspace: source.cwd });
    if (existing && connectionFingerprint(project(existing)) !== connectionFingerprint(project(candidate))) return null;
    if (!existing && servers.length >= 32) return null;
    for (const draft of drafts.values()) {
      if (draft.owner === owner && draft.key === key && (draft.phase !== 'ready' || draft.expiresAt > now())) return draft;
    }
    for (const [token, draft] of drafts) if (draft.phase === 'ready' && draft.expiresAt <= now()) drafts.delete(token);
    if (drafts.size >= 32) throw closedError('STARTUP_RECOVERY_CAPACITY');
    const token = makeId();
    const draft = { token, owner, key, phase: 'ready', sourceId, sourceSignature: signature(source),
      original, candidate, command: program.command, expiresAt: now() + 120000,
      existing: Boolean(existing) };
    drafts.set(token, draft);
    return draft;
  }
  const preview = draft => ({ token: draft.token, sourceId: draft.sourceId, sourceLabel: draft.original.label,
    targetId: draft.candidate.id, command: draft.command, usesCurrentAccountConfiguration: true,
    keepsOriginalConnection: true, existing: draft.existing, publicationState: draft.phase,
    ...(draft.receipt ? { receipt: draft.receipt } : {}) });
  return async function handleCurrentInstallationRecovery(request, response, pathname, requestUrl) {
    if (pathname !== '/api/startup/current-installation') return false;
    const owner = await authorize(request);
    if (!owner) { respond(response, 403, { error: 'Gateway browser authorization required' }); return true; }
    if (request.method === 'GET') {
      try {
        const draft = prepare(requestUrl.searchParams.get('source') || 'local', owner);
        respond(response, 200, draft ? { available: true, preview: preview(draft) } : { available: false });
      } catch { respond(response, 503, { error: 'Current installation recovery is unavailable' }); }
      return true;
    }
    if (request.method !== 'POST') { respond(response, 405, { error: 'Method not allowed' }); return true; }
    if (!sameOrigin(request)) { respond(response, 403, { error: 'Same-origin JSON request required' }); return true; }
    let published = false, draft, publishingThisAttempt = false;
    try {
      const input = JSON.parse(await readBody(request, 2048));
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['token', 'label'].includes(key))) throw closedError('STARTUP_RECOVERY_INVALID_REQUEST');
      draft = drafts.get(input.token);
      if (!draft || draft.owner !== owner) throw closedError('STARTUP_RECOVERY_PREVIEW_REQUIRED');
      if (draft.requestedLabel !== undefined && draft.requestedLabel !== input.label) throw closedError('STARTUP_RECOVERY_OPERATION_CONFLICT');
      if (draft.phase === 'complete') { respond(response, 200, draft.receipt); return true; }
      if (draft.phase !== 'ready') throw closedError('CONFIG_FILE_PUBLISH_UNCONFIRMED');
      await serialize(async () => {
        if (await authorize(request) !== owner) throw closedError('STARTUP_RECOVERY_OWNER_CHANGED');
        if (draft.requestedLabel !== undefined && draft.requestedLabel !== input.label) throw closedError('STARTUP_RECOVERY_OPERATION_CONFLICT');
        if (draft.phase === 'complete') return;
        if (draft.phase !== 'ready') throw closedError('CONFIG_FILE_PUBLISH_UNCONFIRMED');
        if (draft.expiresAt <= now()) throw closedError('STARTUP_RECOVERY_PREVIEW_EXPIRED');
        const servers = getServers(), original = servers.find(server => server.id === draft.sourceId);
        if (!original || signature(original) !== draft.sourceSignature || currentProgram()?.command !== draft.command) throw closedError('STARTUP_RECOVERY_SOURCE_CHANGED');
        const candidate = normalize({ ...project(draft.candidate), label: input.label });
        if (!(await stat(candidate.cwd).catch(() => null))?.isDirectory()) throw closedError('STARTUP_RECOVERY_WORKSPACE_UNAVAILABLE');
        draft.requestedLabel = input.label;
        const existing = servers.find(server => server.id === candidate.id);
        if (existing && connectionFingerprint(project(existing)) !== connectionFingerprint(project(draft.candidate))) throw closedError('STARTUP_RECOVERY_TARGET_CONFLICT');
        if (existing) {
          draft.phase = 'complete'; draft.receipt = { serverId: existing.id, sourcePreserved: true, alreadyImported: true };
          return;
        }
        if (servers.length >= 32) throw closedError('STARTUP_RECOVERY_CAPACITY');
        if (await authorize(request) !== owner || currentProgram()?.command !== draft.command ||
            getServers().find(server => server.id === original.id) !== original) throw closedError('STARTUP_RECOVERY_SOURCE_CHANGED');
        draft.phase = 'publishing';
        publishingThisAttempt = true;
        const publication = await publish([...servers, candidate]);
        published = true;
        if (publication?.unconfirmed) throw publication.unconfirmed;
        draft.phase = 'complete'; draft.receipt = { serverId: candidate.id, sourcePreserved: true, originalServerId: original.id };
      });
      respond(response, 200, draft.receipt);
    } catch (error) {
      if (publishingThisAttempt && draft?.phase === 'publishing') draft.phase = 'unknown';
      const unknown = configurationPublicationFailure(error, published);
      respond(response, unknown ? 409 : 400, unknown ?? { error: typeof error.code === 'string' && error.code.startsWith('STARTUP_RECOVERY_') ? error.code : 'STARTUP_RECOVERY_FAILED' });
    }
    return true;
  };
}

/** The original publisher still owns serialization, private-file publication
 * and unknown-result fencing. Import never restarts or terminates old targets.
 */
export async function publishCurrentInstallationCatalog(values, { getServers, persist, replace, refreshAccess }) {
  const previousIds = getServers().map(server => server.id);
  const publication = await persist(values);
  replace(values);
  try { await refreshAccess(previousIds); }
  catch { throw Object.assign(new Error('CONFIG_FILE_PUBLISH_UNCONFIRMED'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' }); }
  return publication;
}

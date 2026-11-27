import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AGENT_MESSAGE_TARGET_FILTER_FIELDS, validAgentMessageTargetQuery, validAgentMessageTargetSelector } from '../shared/agentMessageMethods.mjs';
import { isContract } from '../shared/generated/validator.mjs';
import { AgentMessageRouterError, identityContains, requireRouter, sameAddress } from './agent-message-router-private.js';
import { AGENT_MESSAGE_MAX_READ_BYTES } from './agent-message-router-session-read.js';

const TTL_MS = 120_000;
const MAX_CURSORS = 128;
const invalidCursor = () => new AgentMessageRouterError('AGENT_MESSAGES_CURSOR_INVALID', -32602);

function projectTargets(rows, filters, matchesAddress) {
  const seen = new Set();
  return rows.map(row => {
    requireRouter(validAgentMessageTargetSelector(row) && row.threadId === row.address?.threadId &&
      matchesAddress(row.address) && !seen.has(row.threadId) &&
      (filters.status == null || row.status === filters.status) &&
      (filters.presence == null || row.presence === filters.presence) &&
      (filters.allowedMode == null || row.allowedModes.includes(filters.allowedMode)),
    'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
    seen.add(row.threadId);
    return { ...row, ...(typeof row.title === 'string' && { title: [...row.title.replace(/[\p{Cc}]/gu, '')].slice(0, 200).join('') }) };
  });
}

/** A cursor retains positions in the recipient's own directory and the single eligible peer. */
export async function listWakeTargets({ cursors, now = Date.now, owner, broker, attempt, origin, query, peerSupported,
  localIdentity, readLocal, readPeer, verify }) {
  const filters = Object.fromEntries(AGENT_MESSAGE_TARGET_FILTER_FIELDS.filter(key => query[key] != null).map(key => [key, query[key]]));
  const previous = query.cursor == null ? null : cursors.get(query.cursor);
  if (query.cursor != null && (!previous || previous.expires <= now() || previous.owner !== owner || previous.broker !== broker ||
      previous.messageId !== origin.messageId || !isDeepStrictEqual(previous.attempt, attempt))) throw invalidCursor();
  if (previous && Object.keys(filters).some(key => previous.filters[key] !== filters[key]))
    throw new AgentMessageRouterError('AGENT_MESSAGES_CURSOR_FILTER_MISMATCH', -32602);
  const state = previous ? { ...previous } : {
    owner, broker, attempt: { ...attempt }, messageId: origin.messageId, filters, limit: 10,
    authorizationId: randomUUID(), phase: 'local', nativeCursor: null,
  };
  state.limit = query.limit ?? state.limit;
  const remoteWanted = peerSupported && !identityContains(localIdentity, origin.sender) &&
    (state.filters.targetId == null || state.filters.targetId === origin.sender.targetId);
  let page = { coverage: 'workspace_history', observedAtMs: now(), completeness: 'partial', targets: [] };
  if (state.phase === 'local') {
    if (state.filters.targetId == null || state.filters.targetId === origin.recipient.targetId) {
      const selection = state.nativeCursor ? { cursor: state.nativeCursor } : state.filters;
      page = await readLocal({ ...selection, limit: state.limit }, state.authorizationId);
      requireRouter(isContract('CrossSessionMessageTargetsResult', page) && page.targets.length <= state.limit &&
        (page.nextCursor == null || page.nextCursor !== state.nativeCursor && validAgentMessageTargetQuery({ cursor: page.nextCursor })) &&
        Buffer.byteLength(JSON.stringify(page)) <= AGENT_MESSAGE_MAX_READ_BYTES, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
      page = { ...page, targets: projectTargets(page.targets, state.filters,
        address => identityContains(localIdentity, address) && !sameAddress(address, origin.recipient)) };
      state.nativeCursor = page.nextCursor ?? null;
    }
    if (state.nativeCursor == null) state.phase = remoteWanted ? 'peer' : 'done';
  }
  if (state.phase === 'peer' && page.targets.length === 0) {
    if (remoteWanted) {
      page = await readPeer({ ...state.filters, limit: state.limit });
      requireRouter(isContract('CrossSessionMessageTargetsResult', page) && page.completeness === 'partial' &&
        page.nextCursor == null && page.targets.length <= 1 &&
        Buffer.byteLength(JSON.stringify(page)) <= AGENT_MESSAGE_MAX_READ_BYTES, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
      page = { ...page, targets: projectTargets(page.targets, state.filters, address => sameAddress(address, origin.sender)) };
    }
    state.phase = 'done';
  }
  await verify();
  if (previous && cursors.get(query.cursor) !== previous) throw invalidCursor();
  const { nextCursor: _nativeCursor, ...result } = page;
  if (state.phase !== 'done') {
    for (const [key, value] of cursors) if (value.expires <= now()) cursors.delete(key);
    requireRouter(previous || cursors.size < MAX_CURSORS, 'AGENT_MESSAGES_CURSOR_LIMIT');
    result.nextCursor = randomBytes(24).toString('hex');
    cursors.set(result.nextCursor, { ...state, expires: now() + TTL_MS });
  }
  if (previous) cursors.delete(query.cursor);
  return { ...result, completeness: 'partial' };
}

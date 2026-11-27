// Live Native workspaces are bounded routing hints, never filesystem or task grants.
import { isTargetWorkspaceAbsolute } from './remotes/target-workspace-path.mjs';
const MAX_WORKSPACES = 64;
const validPath = (target, value) => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= 4096 && !/[\p{Cc}]/u.test(value) && isTargetWorkspaceAbsolute(target, value);

export function createRuntimeServerInventory({ getServers, getBrokers, publicServer, loginContexts,
  targetSignature, observationIdentity, authorityIdFor, localMcpPresets = () => undefined }) {
  return { publicServerInventory(session, loginOwner) {
    const entries = getServers().filter(target => session.allowedServerIds.has(target.id)).map(target => {
      const principal = loginOwner ? loginContexts.identity(loginOwner, target.id) : null;
      return { target, presets: localMcpPresets(target), signature: targetSignature(target), paths: new Set(), truncated: false, principal,
        generation: target.security && principal ? loginContexts.generation(loginOwner, target.id) : undefined };
    });
    const pending = new Map(entries.filter(({ target, principal, generation }) => !target.security ||
      principal && Number.isSafeInteger(generation) && generation >= 0).map(entry => [entry.target.id, entry]));
    let observed = 0;
    for (const broker of pending.size ? getBrokers() : []) {
      if (++observed > 1024) { for (const entry of pending.values()) entry.truncated = true; break; }
      const entry = pending.get(broker?.serverId);
      if (!entry) continue;
      const { target, signature, generation, paths } = entry;
      if (broker.closed || broker.nativeManagementOnly || broker.targetId !== target.id ||
          broker.agentMessageTargetSignature !== signature ||
          broker.child?.exitCode !== null || broker.child?.signalCode !== null ||
          target.security && (broker.loginOwner !== loginOwner ||
            broker.agentMessageAccountGeneration !== generation)) continue;
      const initialized = broker.initializeResponse;
      const path = initialized?.result?.cwd;
      if (!initialized || initialized.error || !validPath(target, path) || paths.has(path)) continue;
      if (paths.size >= MAX_WORKSPACES) {
        entry.truncated = true;
        pending.delete(target.id);
        if (!pending.size) break;
      } else paths.add(path);
    }
    return { servers: entries.map(({ target, signature, principal, paths, truncated, presets }) => ({
      ...publicServer(target), ...(presets ? { localMcpPresets: presets } : {}), observationTargetIdentity: observationIdentity(signature),
      ...(target.transport === 'ssh' ? { authorityId: authorityIdFor(target) } : {}),
      ...(principal ? { accountIdentity: principal } : {}),
      ...(paths.size || truncated ? { workspaceHints: { version: 1, paths: [...paths], ...(truncated ? { truncated: true } : {}) } } : {}),
    })) };
  } };
}

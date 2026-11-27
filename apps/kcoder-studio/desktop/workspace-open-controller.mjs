import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isTrustedGatewayUrl } from './security-policy.mjs';

export function parseWorkspaceOpenRequest(argv, cwd) {
  if (!Array.isArray(argv) || argv.length > 4096 || argv.some(value => typeof value !== 'string'))
    throw new Error('Invalid workspace-open command line');
  let path, label, serverId;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--open-workspace', '--workspace-label', '--workspace-server'].includes(flag)) continue;
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || value.includes('\0') || value.length > 32767)
      throw new Error('Invalid workspace-open argument');
    if (flag === '--open-workspace') path = value;
    else if (flag === '--workspace-label') label = value;
    else serverId = value;
  }
  if (!path) return null;
  if (!isAbsolute(path) && !isAbsolute(cwd || '')) throw new Error('Workspace-open requires an absolute working directory');
  return { id: randomUUID(), path: isAbsolute(path) ? path : resolve(cwd, path), ...(label ? { label } : {}), ...(serverId ? { serverId } : {}) };
}

const identity = server => JSON.stringify([server.id, server.transport, server.runtime, server.command,
  server.profile, server.settingsFile, server.workspacePath, server.accountIdentity?.principalId, server.observationTargetIdentity]);

/** Ephemeral CLI intent queue. Only the primary local desktop can consume it. */
export function createWorkspaceOpenController({ ipcMain, getWindow, getGatewayOrigin, getServers }) {
  const requests = new Map();
  let disposed = false;
  const authorize = event => {
    const window = getWindow();
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || !isTrustedGatewayUrl(event.senderFrame?.url, getGatewayOrigin()))
      throw new Error('Workspace-open is restricted to the primary local desktop frame');
    return { window, frame: event.senderFrame, origin: getGatewayOrigin() };
  };
  const recheck = (event, owner) => {
    const current = authorize(event);
    if (current.window !== owner.window || current.frame !== owner.frame || current.origin !== owner.origin)
      throw new Error('Workspace-open owner changed');
  };
  ipcMain.handle('kcoder:workspace-open:pending', async event => {
    const owner = authorize(event);
    if (!requests.size) return [];
    const servers = await getServers(); recheck(event, owner);
    const output = [];
    for (const request of requests.values()) {
      try {
        const candidates = servers.filter(server => server.transport === 'local' && (!request.serverId || server.id === request.serverId));
        if (candidates.length !== 1) throw new Error('Workspace-open requires one local target; specify --workspace-server when there are multiple');
        const server = candidates[0], targetIdentity = identity(server);
        if (request.targetIdentity && request.targetIdentity !== targetIdentity) throw new Error('Workspace-open target changed; submit the command again');
        const metadata = await stat(request.path); recheck(event, owner);
        if (!metadata.isDirectory()) throw new Error('Workspace-open requires a directory');
        // Recheck target edits while filesystem inspection was pending.
        const current = (await getServers()).find(value => value.id === server.id); recheck(event, owner);
        if (!current || identity(current) !== targetIdentity) throw new Error('Workspace-open target changed');
        request.serverId = server.id; request.targetIdentity = targetIdentity;
        output.push({ id: request.id, path: request.path, ...(request.label ? { label: request.label } : {}), serverId: server.id });
      } catch (error) {
        recheck(event, owner);
        output.push({ id: request.id, error: error.code ? 'Unable to read the requested local directory' : error.message });
      }
    }
    return output;
  });
  ipcMain.handle('kcoder:workspace-open:ack', (event, id) => {
    authorize(event);
    if (typeof id !== 'string' || !requests.has(id)) throw new Error('Unknown workspace-open request');
    requests.delete(id);
  });
  return {
    enqueue(request) {
      if (!request || disposed) return;
      if (requests.size >= 64) throw new Error('Too many pending workspace-open requests');
      requests.set(request.id, { ...request });
      const window = getWindow();
      if (window && !window.isDestroyed() && isTrustedGatewayUrl(window.webContents.getURL(), getGatewayOrigin()))
        window.webContents.send('kcoder:workspace-open:changed');
    },
    dispose() { disposed = true; requests.clear(); ipcMain.removeHandler('kcoder:workspace-open:pending'); ipcMain.removeHandler('kcoder:workspace-open:ack'); },
  };
}

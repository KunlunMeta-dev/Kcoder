import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRelayPrivateText, writeRelayConfiguration } from './gateway-relay-instance.js';

const surfaces = ['desktopWeb', 'mobileWeb', 'mobileApp'];
const defaults = Object.freeze({ desktopWeb: true, mobileWeb: true, mobileApp: true });

function validPolicy(value) {
  return value && Object.keys(value).length === surfaces.length &&
    surfaces.every(surface => typeof value[surface] === 'boolean');
}

export async function loadGatewayPublicAccess(directory) {
  const file = join(directory, 'public-access.json');
  const raw = await readRelayPrivateText(file);
  const saved = raw === null ? { revision: 0, surfaces: defaults } : JSON.parse(raw);
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || !validPolicy(saved.surfaces)) {
    throw Error('Invalid Gateway public access policy');
  }
  let state = saved;
  let queue = Promise.resolve();
  const connections = new Map();
  const allows = surface => state.surfaces[surface] === true;
  const track = (surface, connection) => {
    if (!allows(surface)) return false;
    connections.set(connection, surface);
    const release = () => connections.delete(connection);
    connection.once('close', release);
    return true;
  };
  return {
    get state() { return state; },
    allows,
    track,
    async admitHttp(request, response, path, getSession, jsonResponse) {
      if (request.method === 'OPTIONS' ||
          (request.method === 'POST' && ['/api/mobile/session', '/api/mobile/session/refresh'].includes(path)) ||
          path === '/api/mobile/p2p' || path === '/api/mobile/p2p/offer') return true;
      const session = request.headers.authorization === undefined ? null : await getSession(request);
      const surface = publicRequestSurface(path, session, request.headers.authorization !== undefined);
      if (path === '/api/relay/public-access' ? allows(surface) : track(surface, response)) return true;
      jsonResponse(response, 403, { error: 'Public access is disabled' });
      return false;
    },
    update(input, afterSave) {
      const update = queue.then(async () => {
        if (Object.keys(input).length !== 2 || !validPolicy(input.surfaces)) return 400;
        if (input.expectedRevision !== state.revision) return 409;
        const next = { revision: state.revision + 1, surfaces: input.surfaces };
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeRelayConfiguration(file, next);
        state = next;
        for (const [socket, surface] of connections) if (!allows(surface)) socket.destroy();
        afterSave?.();
        return 200;
      });
      queue = update.catch(() => {});
      return update;
    },
  };
}

export function publicRequestSurface(path, session, hasDeviceCredential) {
  if (path === '/mobile' || path.startsWith('/mobile/')) return 'mobileWeb';
  if (session?.surface === 'mobileWeb') return 'mobileWeb';
  return hasDeviceCredential || session?.deviceId ? 'mobileApp' : 'desktopWeb';
}

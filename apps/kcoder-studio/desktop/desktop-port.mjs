import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error(`${label} must be an integer from 1 to 65535`), { code: 'DESKTOP_PORT_INVALID' });
  }
  return port;
}

function canBind(port) {
  return new Promise((resolveAvailable) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolveAvailable(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolveAvailable(true));
    });
  });
}

export async function resolveDesktopPort({ userDataDir, configuredPort } = {}) {
  if (configuredPort !== undefined && String(configuredPort).trim() !== "") {
    return parsePort(configuredPort, "KCODER_STUDIO_DESKTOP_PORT");
  }
  if (!userDataDir) throw new Error("KCoder Studio user-data directory is required");
  const portFile = join(userDataDir, "gateway-port");
  try {
    return parsePort((await readFile(portFile, "utf8")).trim(), "persisted desktop gateway port");
  } catch (error) {
    if (!['ENOENT', 'DESKTOP_PORT_INVALID'].includes(error?.code)) throw error;
  }

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomInt(42_000, 55_000);
    if (!(await canBind(candidate))) continue;
    await mkdir(userDataDir, { recursive: true });
    const temporary = `${portFile}.${randomUUID()}.tmp`;
    let file, created = false;
    try {
      file = await open(temporary, 'wx');
      created = true;
      await file.writeFile(`${candidate}\n`); await file.sync(); await file.close(); file = null;
      await rename(temporary, portFile);
    } finally {
      await file?.close();
      if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return candidate;
  }
  throw new Error("Unable to allocate a stable loopback port for KCoder Studio");
}


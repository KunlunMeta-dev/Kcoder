import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
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
    if (error?.code !== "ENOENT") throw error;
  }

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomInt(42_000, 55_000);
    if (!(await canBind(candidate))) continue;
    await mkdir(userDataDir, { recursive: true });
    await writeFile(portFile, `${candidate}\n`, { mode: 0o600 });
    return candidate;
  }
  throw new Error("Unable to allocate a stable loopback port for KCoder Studio");
}


import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.argv.length, 3, "the owned Relay worker accepts one private config path");
const configPath = resolve(process.argv[2]);
const config = JSON.parse(await readFile(configPath, "utf8"));
assert.deepEqual(Object.keys(config).sort(), ["connectTimeout", "readyFile", "registrationKey", "registrationStoreFile", "serverModule", "sharedHosts"]);
assert.equal(typeof config.registrationKey, "string");
assert.ok(config.registrationKey.length >= 32);
assert.ok(Array.isArray(config.sharedHosts) && config.sharedHosts.length === 1 && typeof config.sharedHosts[0] === "string");
assert.equal(Number.isInteger(config.connectTimeout), true);
for (const key of ["serverModule", "registrationStoreFile", "readyFile"]) {
  assert.equal(typeof config[key], "string");
  assert.equal(config[key].startsWith("/"), true);
}

const { startRelay } = await import(pathToFileURL(config.serverModule).href);
let relay;
let closePromise;
async function close(exitCode = 0) {
  if (!closePromise) {
    closePromise = (async () => {
      try { await relay?.close(); }
      catch { exitCode = 1; }
      process.exit(exitCode);
    })();
  }
  return closePromise;
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void close(0); });

try {
  relay = await startRelay({ gateways: [], sharedHosts: config.sharedHosts, registrationKey: config.registrationKey,
    registrationStoreFile: config.registrationStoreFile, controlPort: 0, proxyPort: 0, connectTimeout: config.connectTimeout });
  await writeFile(config.readyFile, `${JSON.stringify({ controlPort: relay.controlPort, proxyPort: relay.proxyPort })}\n`,
    { flag: "wx", mode: 0o600 });
} catch (error) {
  const code = ["EADDRINUSE", "EACCES", "ENOENT", "EIO"].includes(error?.code) ? error.code : "other";
  process.stderr.write(`Node 18 Relay worker failed (${code})\n`);
  await close(1);
}

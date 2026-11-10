import assert from "node:assert/strict";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { waitFor } from "./run-context.mjs";
import { ownedNativeBuildInputs, runOwnedNativePhase } from "./owned-dependencies.mjs";

export function mobileDevelopmentArguments(expoCli, port) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Metro requires a reserved TCP port");
  return [expoCli, "start", "--web", "--localhost", "--port", String(port), "--max-workers", "4"];
}

/** Start Metro only inside a writable RunContext source/dependency snapshot. */
export async function startMobileDevelopmentServer(context, { mobileRoot, label = "mobile-metro" }) {
  assert.ok(resolve(mobileRoot).startsWith(`${context.stateDir}/`), "Metro source must belong to this run");
  const inputs = ownedNativeBuildInputs(mobileRoot);
  await writeFile(resolve(mobileRoot, "metro.config.cjs"), `${inputs.metroConfig}
c.resolver.assetExts=[...new Set([...c.resolver.assetExts,'txt'])];
// Expo Font shares the SDK-owned Asset package in the installed dependency tree.
const {createRequire}=require('node:module');
const expoRequire=createRequire(require.resolve('expo/package.json'));
c.resolver.extraNodeModules={...c.resolver.extraNodeModules,'expo-asset':dirname(expoRequire.resolve('expo-asset/package.json'))};
`, { mode: 0o600 });
  const env = context.isolatedEnvironment({ CI: "1", EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_CACHE: "1", NODE_ENV: "development" });
  await runOwnedNativePhase(context, { label: `${label}-terminal`, command: process.execPath,
    args: [resolve(mobileRoot, "scripts/build-terminal-webview.mjs")], cwd: mobileRoot, env, timeoutMs: 60_000 });
  const reservation = createServer();
  await new Promise((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  context.addCleanup(`close ${label} port reservation`, async () => {
    if (reservation.listening) await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
  });
  const port = reservation.address().port;
  context.registerPort(label, port);
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const child = context.spawnOwned(label, process.execPath, mobileDevelopmentArguments(inputs.expoCli, port), { cwd: mobileRoot, env });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Owned Metro exited before readiness");
    try {
      const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.text()).includes("packager-status:running");
    } catch { return false; }
  }, 60_000, "owned Metro readiness", 100, context.abortSignal);
  return { baseUrl, pid: child.pid, port };
}

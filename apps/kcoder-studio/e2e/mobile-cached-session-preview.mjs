import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RunContext, waitFor } from "./harness/run-context.mjs";
import { createFixtureProxy } from "./fixtures/mobile-cached-session/auth-proxy.mjs";

// User-requested persistent review fixture. SIGTERM cleans only this run's resources.
const fixture = fileURLToPath(new URL("./fixtures/mobile-cached-session/", import.meta.url));
const mobile = resolve(fixture, "../../../mobile");
const prefix = process.env.KCODER_CACHE_FIXTURE_PREFIX || "/fixtures/mobile-cache";
const port = Number(process.env.KCODER_CACHE_FIXTURE_PORT || 14280);
const metroPort = Number(process.env.KCODER_CACHE_FIXTURE_METRO_PORT || 14281);
const publicOrigin = process.env.KCODER_CACHE_FIXTURE_ORIGIN || `http://127.0.0.1:${port}`;
const context = await RunContext.create(import.meta.url, {
  testId: "mobile-cached-session-layout-preview", tier: "manual-live", modelPolicy: "model-independent",
});
let stopped = false;
async function stop(error) {
  if (stopped) return;
  stopped = true;
  try { await context.finish(error ? "failed" : "passed", { persistentReviewEnded: true }, error); }
  finally { process.exit(error ? 1 : 0); }
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  const modules = resolve(fixture, "node_modules");
  const target = resolve(mobile, "node_modules");
  try {
    await symlink(target, modules);
    context.addCleanup("remove owned fixture dependency link", () => rm(modules));
  } catch (error) {
    if (error.code !== "EEXIST" || await readlink(modules) !== target) throw error;
    throw new Error("Another cached-session fixture owns the dependency link");
  }
  const accessFile = process.env.KCODER_CACHE_FIXTURE_ACCESS_FILE;
  let token;
  if (accessFile) {
    const stat = await lstat(accessFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
      throw new Error("Fixture access file must be a private, owned regular file");
    token = JSON.parse(await readFile(accessFile, "utf8")).token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid fixture access credential");
  } else token = randomBytes(32).toString("base64url");
  context.registerSecret(token);
  const credentialFile = await context.writeStateJson("access.json", { token });
  const env = context.isolatedEnvironment({
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_TYPESCRIPT_SETUP: "1",
    EXPO_HOME: context.pathInState("expo-home"), XDG_CACHE_HOME: context.pathInState("cache"),
    TMPDIR: context.pathInState("tmp"),
    KCODER_CACHE_FIXTURE_PREFIX: prefix, KCODER_CACHE_FIXTURE_METRO_PORT: String(metroPort),
  });
  for (const path of [env.EXPO_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) await mkdir(path, { recursive: true, mode: 0o700 });
  context.registerPort("fixture-auth-proxy", port);
  context.registerPort("fixture-metro", metroPort);
  const metro = context.spawnOwned("metro", process.execPath, ["--require", resolve(fixture, "loopback.cjs"),
    resolve(mobile, "node_modules/expo/bin/cli"), "start", "--web", "--host", "localhost", "--port", String(metroPort)], { cwd: fixture, env });
  await waitFor(async () => {
    if (metro.exitCode !== null) throw new Error("Fixture Metro exited during startup");
    try { return (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok; } catch { return false; }
  }, 60_000, "fixture Metro ready", 250);
  const proxy = createFixtureProxy({ prefix, publicOrigin, upstreamPort: metroPort, token });
  await new Promise((done, fail) => { proxy.server.once("error", fail); proxy.server.listen(port, "127.0.0.1", done); });
  context.addCleanup("close authenticated fixture proxy", proxy.close);
  metro.once("exit", () => { if (!stopped) void stop(new Error("Fixture Metro exited")); });
  await context.writeArtifactJson("preview.json", { prefix, publicOrigin, port, metroPort,
    source: "apps/kcoder-studio/mobile/src/features/task/CachedSessionView.tsx",
    mode: "permanent-cache-only", history: "synthetic", startupLogicChanged: false });
  console.log(JSON.stringify({ ready: true, runRoot: context.runRoot, credentialFile, prefix, publicOrigin, port, metroPort }));
} catch (error) {
  await stop(error);
}

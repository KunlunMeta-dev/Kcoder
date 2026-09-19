import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appServerEnvironment, launchSpec, loadServers, normalizeServer, publicServer, storedServer } from "../src/server-config.js";

const defaults = { repoRoot: "/repo", appServerBin: "/repo/target/debug/kcoder", workspace: "/repo" };

test('account targets preserve identity and invoke only the restricted SSH marker', () => {
  const security = { identity: { mode: 'kcoder-account', username: 'alice' } };
  const target = normalizeServer({ id: 'alice', label: 'Alice', transport: 'ssh', host: 'host.test', user: 'root', security }, defaults);
  assert.deepEqual(publicServer(target).security, security);
  assert.deepEqual(storedServer(target).security, security);
  const spec = launchSpec(target, { workspacePath: '/private/work' });
  assert.equal(spec.args.at(-1), 'kcoder-account');
  assert.equal(spec.args.includes('/private/work'), false);
  assert.equal(spec.args.includes('app-server'), false);
  assert.throws(() => normalizeServer({ id: 'bad', label: 'Bad', transport: 'local', security }, defaults));
  assert.throws(() => normalizeServer({ id: 'bad', label: 'Bad', host: 'host.test', security, settingsFile: '/root/settings.json' }, defaults));
  assert.throws(() => normalizeServer({ id: 'bad', label: 'Bad', host: 'host.test', security: { identity: { ...security.identity, password: 'must-not-be-persisted' } } }, defaults));
});

test("uses one local server by default", async () => {
  const servers = await loadServers({ env: {}, ...defaults });
  assert.equal(servers.length, 1);
  assert.deepEqual(publicServer(servers[0]), {
    id: "local", label: "当前计算机", description: "本机 KCoder app-server", runtime: "kcoder", transport: "local", host: undefined,
    capabilities: { browserSessions: true, fileChangesRevert: true, terminalSessions: true, workspaceFiles: true },
    workspacePath: "/repo", command: "/repo/target/debug/kcoder",
  });
  assert.deepEqual(launchSpec(servers[0]), {
    command: "/repo/target/debug/kcoder", args: ["app-server"], cwd: "/repo",
  });
});

test("Windows local targets preserve drive paths, spaces and Unicode as argv", () => {
  const windowsDefaults = {
    ...defaults, platform: "win32", appServerBin: String.raw`C:\Program Files\KCoder Studio\resources\bin\kcoder.exe`,
    workspace: String.raw`C:\Users\测试用户\My Project`,
  };
  const target = normalizeServer({ id: "local", label: "Windows", transport: "local",
    settingsFile: String.raw`C:\Users\测试用户\settings file.json`,
    chromiumBin: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  }, windowsDefaults);
  assert.equal(target.command, windowsDefaults.appServerBin);
  assert.equal(target.cwd, windowsDefaults.workspace);
  const spec = launchSpec(target, { platform: "win32", workspacePath: String.raw`D:\Code Projects\demo` });
  assert.equal(spec.command, windowsDefaults.appServerBin);
  assert.equal(spec.cwd, String.raw`D:\Code Projects\demo`);
  assert.deepEqual(spec.args, ["--settings-file", String.raw`C:\Users\测试用户\settings file.json`,
    "--cwd", String.raw`D:\Code Projects\demo`, "app-server"]);
  assert.equal(spec.env.KCODER_CHROMIUM_BIN, String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`);
  assert.throws(() => normalizeServer({ id: "bad", label: "Bad", transport: "local",
    command: "C:\\bin\\kcoder.exe\u0000extra" }, windowsDefaults), /invalid local command/);
});

test("Windows hosts keep Linux SSH workspace paths independent of local path rules", () => {
  const target = normalizeServer({ id: "linux", label: "Linux", transport: "ssh",
    host: "build-01", workspace: "/srv/project" }, { ...defaults, platform: "win32" });
  assert.deepEqual(launchSpec(target, { platform: "win32", workspacePath: "/data/project" }).args.slice(-3),
    ["--cwd", "/data/project", "app-server"]);
  assert.throws(() => launchSpec(target, { platform: "win32", workspacePath: String.raw`C:\wrong-host` }),
    /invalid .*workspace/);
});

test("defaults targets to KCoder and persists the explicit runtime discriminator", () => {
  const target = normalizeServer({
    id: "legacy", label: "Legacy", transport: "ssh", host: "build-01",
  }, defaults);
  assert.equal(target.runtime, "kcoder");
  assert.equal(publicServer(target).runtime, "kcoder");
  assert.equal(storedServer(target).runtime, "kcoder");
  assert.throws(
    () => normalizeServer({ id: "bad", label: "Bad", runtime: "other", transport: "local" }, defaults),
    /unsupported runtime/,
  );
});

test("rejects removed Codex targets and relative remote workspaces", () => {
  assert.throws(
    () => normalizeServer({ id: "codex", label: "Codex", runtime: "codex", transport: "local" }, defaults),
    /unsupported runtime.*codex/,
  );
  assert.throws(
    () => normalizeServer({ id: "remote", label: "Remote", transport: "ssh", host: "build-01", workspace: "relative/path" }, defaults),
    /remote workspace must be absolute/,
  );
});

test("a mutable server store takes precedence over launch-time environment defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kcoder-server-store-"));
  const store = join(directory, "servers.json");
  await writeFile(store, JSON.stringify([{ id: "saved", label: "Saved", transport: "ssh", host: "saved-host" }]));
  const servers = await loadServers({
    env: {
      KCODER_STUDIO_SERVERS_STORE: store,
      KCODER_STUDIO_SERVERS: JSON.stringify([{ id: "launch", label: "Launch", transport: "local" }]),
    },
    ...defaults,
  });
  assert.deepEqual(servers.map(server => server.id), ["saved"]);
});

test("scrubs gateway and Electron secrets from model-driven app-server children", () => {
  assert.deepEqual(
    appServerEnvironment(
      {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        KCODER_STUDIO_AUTH_TOKEN: "must-not-leak",
        KCODER_STUDIO_PUBLIC_ORIGINS: "https://studio.example",
        KCODER_STUDIO_DESKTOP_SECRET: "also-private",
        ELECTRON_RUN_AS_NODE: "1",
      },
      { KCODER_CHROMIUM_BIN: "/opt/chrome/chrome" },
    ),
    {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      KCODER_CHROMIUM_BIN: "/opt/chrome/chrome",
    },
  );
});

test("builds SSH app-server launch without a shell", async () => {
  const env = { KCODER_STUDIO_SERVERS: JSON.stringify([{
    id: "build-01", label: "构建机", transport: "ssh", host: "build-01", user: "dev", port: 2222,
    workspace: "/srv/project", command: "/usr/local/bin/kcoder",
  }]) };
  const [server] = await loadServers({ env, ...defaults });
  assert.deepEqual(launchSpec(server), {
    command: "ssh",
    args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "dev@build-01", "/usr/local/bin/kcoder", "--cwd", "/srv/project", "app-server"],
    cwd: undefined,
  });
});

test("normalizes editable SSH targets and serializes their complete non-secret configuration", () => {
  const server = normalizeServer({
    id: "gpu-01", label: "GPU 服务器", transport: "ssh", host: "100.64.0.21", user: "devuser",
    port: 2222, workspace: "/data/project", command: "/usr/local/bin/kcoder",
    profile: "minimax", acceptNewHostKey: true,
  }, defaults);
  assert.deepEqual(publicServer(server), {
    id: "gpu-01", label: "GPU 服务器", description: "SSH KCoder app-server", runtime: "kcoder", transport: "ssh",
    capabilities: { browserSessions: true, fileChangesRevert: true, terminalSessions: true, workspaceFiles: true },
    host: "100.64.0.21", user: "devuser", port: 2222, command: "/usr/local/bin/kcoder",
    workspacePath: "/data/project", profile: "minimax", acceptNewHostKey: true,
  });
  assert.deepEqual(storedServer(server), {
    id: "gpu-01", label: "GPU 服务器", description: "SSH KCoder app-server", runtime: "kcoder", transport: "ssh",
    host: "100.64.0.21", user: "devuser", port: 2222, command: "/usr/local/bin/kcoder",
    workspace: "/data/project", profile: "minimax", acceptNewHostKey: true,
  });
  assert.deepEqual(launchSpec(server).args.slice(0, 8), [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-p",
  ]);
});

test("accepts the renderer workspacePath field when saving editable targets", () => {
  const remote = normalizeServer({
    id: "renderer-ssh", label: "Renderer SSH", transport: "ssh", host: "127.0.0.1",
    workspacePath: "/srv/renderer-project",
  }, defaults);
  assert.equal(remote.remoteCwd, "/srv/renderer-project");
  assert.equal(publicServer(remote).workspacePath, "/srv/renderer-project");
  assert.equal(storedServer(remote).workspace, "/srv/renderer-project");

  const local = normalizeServer({
    id: "renderer-local", label: "Renderer Local", transport: "local",
    workspacePath: "/repo/renderer-project",
  }, defaults);
  assert.equal(local.cwd, "/repo/renderer-project");

  const blankLegacyWorkspace = normalizeServer({
    id: "renderer-blank-legacy", label: "Renderer blank legacy", transport: "ssh", host: "127.0.0.1",
    workspace: "   ", workspacePath: "/srv/renderer-fallback",
  }, defaults);
  assert.equal(blankLegacyWorkspace.remoteCwd, "/srv/renderer-fallback");
});

test("binds each app-server process to its requested task workspace", async () => {
  const [local] = await loadServers({ env: {}, ...defaults });
  assert.deepEqual(launchSpec(local, { workspacePath: "/repo/.worktrees/task-1" }), {
    command: "/repo/target/debug/kcoder",
    args: ["--cwd", "/repo/.worktrees/task-1", "app-server"],
    cwd: "/repo/.worktrees/task-1",
  });

  const [remote] = await loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([{
    id: "build-01", label: "构建机", transport: "ssh", host: "build-01",
    workspace: "/srv/project", command: "/usr/local/bin/kcoder",
  }]) }, ...defaults });
  assert.deepEqual(
    launchSpec(remote, { workspacePath: "/srv/worktrees/task-1" }).args.slice(-3),
    ["--cwd", "/srv/worktrees/task-1", "app-server"],
  );
  assert.throws(
    () => launchSpec(remote, { workspacePath: "/srv/project;touch/tmp/injected" }),
    /invalid remote task workspace/,
  );
});

test("places a local settings overlay and explicit profile before the app-server subcommand", async () => {
  const env = { KCODER_STUDIO_SERVERS: JSON.stringify([{
    id: "local", label: "本机", transport: "local", workspace: "/repo/workspace",
    settingsFile: "/repo/studio.settings.json", profile: "minimax",
  }]) };
  const [server] = await loadServers({ env, ...defaults });
  assert.deepEqual(launchSpec(server), {
    command: "/repo/target/debug/kcoder",
    args: ["--settings-file", "/repo/studio.settings.json", "--profile", "minimax", "app-server"],
    cwd: "/repo/workspace",
  });
});

test("passes validated per-target Chromium settings locally and over SSH", async () => {
  const env = { KCODER_STUDIO_SERVERS: JSON.stringify([
    {
      id: "local", label: "本机", transport: "local",
      chromiumBin: "/opt/chrome/chrome", chromiumNoSandbox: true,
    },
    {
      id: "remote", label: "远端", transport: "ssh", host: "build-01",
      command: "/usr/local/bin/kcoder",
      settingsFile: "/srv/config/kcoder.json", profile: "minimax",
      chromiumBin: "/opt/chrome/chrome", chromiumNoSandbox: true,
    },
  ]) };
  const [local, remote] = await loadServers({ env, ...defaults });
  assert.deepEqual(launchSpec(local).env, {
    KCODER_CHROMIUM_BIN: "/opt/chrome/chrome",
    KCODER_CHROMIUM_NO_SANDBOX: "1",
  });
  assert.deepEqual(launchSpec(remote).args.slice(-9), [
    "env",
    "KCODER_CHROMIUM_BIN=/opt/chrome/chrome",
    "KCODER_CHROMIUM_NO_SANDBOX=1",
    "/usr/local/bin/kcoder",
    "--settings-file",
    "/srv/config/kcoder.json",
    "--profile",
    "minimax",
    "app-server",
  ]);
});

test("applies the gateway Chromium fallback only to local targets", async () => {
  const fallbackDefaults = { ...defaults, chromiumBin: "/opt/playwright/chrome", chromiumNoSandbox: true };
  const [local, remote] = await loadServers({
    env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "local", label: "本机", transport: "local" },
      { id: "remote", label: "远端", transport: "ssh", host: "build-01" },
    ]) },
    ...fallbackDefaults,
  });
  assert.deepEqual(launchSpec(local).env, {
    KCODER_CHROMIUM_BIN: "/opt/playwright/chrome",
    KCODER_CHROMIUM_NO_SANDBOX: "1",
  });
  assert.equal(launchSpec(remote).args.includes("KCODER_CHROMIUM_BIN=/opt/playwright/chrome"), false);
});

test("rejects duplicate ids and option-like SSH hosts", async () => {
  await assert.rejects(
    loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "same", label: "A", transport: "local" },
      { id: "same", label: "B", transport: "local" },
    ]) }, ...defaults }),
    /duplicate server id/
  );
  await assert.rejects(
    loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "bad", label: "Bad", transport: "ssh", host: "-oProxyCommand=evil" },
    ]) }, ...defaults }),
    /invalid SSH host/
  );
  await assert.rejects(
    loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "bad-profile", label: "Bad", transport: "local", profile: "minimax;evil" },
    ]) }, ...defaults }),
    /invalid provider profile/
  );
  await assert.rejects(
    loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "bad-chrome", label: "Bad", transport: "ssh", host: "build-01", chromiumBin: "/opt/chrome;evil" },
    ]) }, ...defaults }),
    /invalid Chromium command/
  );
  await assert.rejects(
    loadServers({ env: { KCODER_STUDIO_SERVERS: JSON.stringify([
      { id: "bad-sandbox", label: "Bad", transport: "local", chromiumNoSandbox: "yes" },
    ]) }, ...defaults }),
    /must be a boolean/
  );
});

test("rejects scenario values that could be interpreted by an SSH remote shell", async () => {
  const env = { KCODER_STUDIO_SERVERS: JSON.stringify([{
    id: "build-01", label: "构建机", transport: "ssh", host: "build-01",
  }]) };
  const [server] = await loadServers({ env, ...defaults });
  assert.throws(() => launchSpec(server, { scenario: "full-turn; touch /tmp/injected" }), /invalid app-server scenario/);
  assert.deepEqual(launchSpec(server, { scenario: "full-turn" }).args.slice(-3), ["app-server", "--scenario", "full-turn"]);
});


test("Windows SSH uses overlapped stdio while native local and Unix launches retain pipe defaults", () => {
  const server = { id: "remote", transport: "ssh", host: "host", user: "user", command: "kcoder", remoteCwd: "/workspace" };
  assert.deepEqual(launchSpec(server, { platform: "win32" }).stdio, ["overlapped", "overlapped", "overlapped"]);
  assert.equal(launchSpec(server, { platform: "linux" }).stdio, undefined);
  assert.equal(launchSpec({ ...server, transport: "local", cwd: "C:\\workspace" }, { platform: "win32" }).stdio, undefined);
});

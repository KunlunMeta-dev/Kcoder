import { readFile } from "node:fs/promises";
import { resolve, posix, win32 } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_HOST = /^[a-zA-Z0-9][a-zA-Z0-9.:%_-]{0,252}$/;
const SAFE_COMMAND = /^[a-zA-Z0-9_./-]+$/;

export async function loadServers({
  env = process.env,
  repoRoot,
  appServerBin,
  workspace,
  chromiumBin,
  chromiumNoSandbox,
  platform = process.platform,
}) {
  let raw;
  const serversStore = env.KCODER_STUDIO_SERVERS_STORE;
  const inlineServers = env.KCODER_STUDIO_SERVERS;
  const serversFile = env.KCODER_STUDIO_SERVERS_FILE;
  if (serversStore) {
    try {
      raw = JSON.parse(await readFile(resolve(serversStore), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!raw) {
    if (inlineServers) raw = JSON.parse(inlineServers);
    else if (serversFile) {
      raw = JSON.parse(await readFile(resolve(serversFile), "utf8"));
    } else {
      raw = [{ id: "local", label: "当前计算机", transport: "local" }];
    }
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new Error("servers configuration must contain 1-32 entries");
  const seen = new Set();
  return raw.map((entry) => {
    const server = normalizeServer(entry, {
      repoRoot,
      appServerBin,
      workspace,
      chromiumBin,
      chromiumNoSandbox,
      platform,
    });
    if (seen.has(server.id)) throw new Error(`duplicate server id: ${server.id}`);
    seen.add(server.id);
    return server;
  });
}

export function normalizeServer(entry, defaults) {
  const localPaths = defaults.platform === "win32" || (!defaults.platform && process.platform === "win32") ? win32 : posix;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("server entry must be an object");
  const id = requiredString(entry.id, "server id");
  if (!SAFE_ID.test(id)) throw new Error(`invalid server id: ${id}`);
  const label = requiredString(entry.label, `label for ${id}`, 80);
  const runtime = entry.runtime || "kcoder";
  if (runtime !== "kcoder") throw new Error(`unsupported runtime for ${id}: ${runtime}`);
  const transport = entry.transport || "ssh";
  if (transport !== "local" && transport !== "ssh") throw new Error(`invalid transport for ${id}`);
  let security;
  if (entry.security !== undefined) {
    const value = entry.security;
    const identity = value?.identity;
    if (transport !== 'ssh' || !value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'identity') ||
        !identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some(key => !['mode', 'username'].includes(key)) ||
        identity.mode !== 'kcoder-account' ||
        (identity.username !== undefined && (typeof identity.username !== 'string' || !/^[a-z][a-z0-9_.-]{1,31}$/.test(identity.username)))) {
      throw new Error('invalid KCoder account identity configuration');
    }
    if (entry.settingsFile || entry.profile || entry.chromiumBin || entry.chromiumNoSandbox) {
      throw new Error('KCoder account targets manage runtime settings inside the authenticated account');
    }
    // The stored username is only a "last used" hint for the login form; the
    // authenticated identity is decided per login context, never by the
    // connection configuration.
    security = { identity: { mode: 'kcoder-account', ...(identity.username ? { username: identity.username } : {}) } };
  }
  const description = optionalString(entry.description, 120) || `${transport === "local" ? "本机" : "SSH"} KCoder app-server`;
  const profile = optionalString(entry.profile, 64);
  if (profile && !SAFE_ID.test(profile)) throw new Error(`invalid provider profile: ${profile}`);
  const chromiumBin = optionalString(entry.chromiumBin, 512)
    || (transport === "local" ? optionalString(defaults.chromiumBin, 512) : undefined);
  if (chromiumBin && !(transport === "local" ? safeLocalExecutable(chromiumBin, localPaths) : SAFE_COMMAND.test(chromiumBin))) throw new Error(`invalid Chromium command for ${id}`);
  const configuredChromiumNoSandbox = entry.chromiumNoSandbox === undefined
    ? undefined
    : optionalBoolean(entry.chromiumNoSandbox, `chromiumNoSandbox for ${id}`);
  const chromiumNoSandbox = configuredChromiumNoSandbox ?? (transport === "local" ? defaults.chromiumNoSandbox : undefined);
  if (transport === "local") {
    const command = optionalString(entry.command, 512) || defaults.appServerBin;
    if (!safeLocalExecutable(command, localPaths)) throw new Error(`invalid local command for ${id}`);
    const configuredWorkspace = optionalString(entry.workspace, 2048)
      || optionalString(entry.workspacePath, 2048);
    if (configuredWorkspace && !localPaths.isAbsolute(configuredWorkspace)) throw new Error(`local workspace must be absolute for ${id}`);
    const cwd = localPaths.resolve(configuredWorkspace || defaults.workspace);
    const settingsFile = entry.settingsFile ? localPaths.resolve(optionalString(entry.settingsFile, 2048)) : undefined;
    return { id, label, description, runtime, transport, command, cwd, settingsFile, profile, chromiumBin, chromiumNoSandbox };
  }

  const host = requiredString(entry.host, `host for ${id}`, 253);
  if (!SAFE_HOST.test(host) || host.startsWith("-")) throw new Error(`invalid SSH host for ${id}`);
  const user = optionalString(entry.user, 64);
  if (user && !/^[a-zA-Z0-9._-]+$/.test(user)) throw new Error(`invalid SSH user for ${id}`);
  const port = entry.port === undefined ? undefined : Number(entry.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`invalid SSH port for ${id}`);
  const command = security ? 'kcoder-account' : optionalString(entry.command, 512) || "kcoder";
  if (!SAFE_COMMAND.test(command)) throw new Error(`invalid remote command for ${id}`);
  const remoteCwd = optionalString(entry.workspace, 2048)
    || optionalString(entry.workspacePath, 2048);
  if (remoteCwd && !security && !SAFE_COMMAND.test(remoteCwd)) throw new Error(`invalid remote workspace for ${id}`);
  if (remoteCwd && !posix.isAbsolute(remoteCwd)) throw new Error(`remote workspace must be absolute for ${id}`);
  const settingsFile = optionalString(entry.settingsFile, 2048);
  if (settingsFile && !SAFE_COMMAND.test(settingsFile)) throw new Error(`invalid remote settings file for ${id}`);
  const acceptNewHostKey = optionalBoolean(entry.acceptNewHostKey, `acceptNewHostKey for ${id}`);
  return { id, label, description, runtime, transport, host, user, port, command, remoteCwd, settingsFile, profile, chromiumBin, chromiumNoSandbox, acceptNewHostKey, ...(security ? { security } : {}) };
}

/**
 * Strip a Win32 namespace prefix from a configured path. `\\?\UNC\` is
 * rewritten to the plain UNC share form; any other `\\?\` verbatim path keeps
 * its body.
 */
export function stripWindowsNamespace(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  if (value.startsWith("\\\\?\\")) return value.slice("\\\\?\\".length);
  return value;
}

/**
 * Save-side normalization seam: the desktop host persists entries with
 * `JSON.stringify(values.map(storedServer))`, so this runs immediately before
 * persistence and keeps verbatim spellings out of the stored profile.
 */
export function normalizeServerEntryForSave(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const normalized = { ...entry };
  for (const key of ["cwd", "remoteCwd", "workspace"]) {
    if (typeof normalized[key] === "string") normalized[key] = stripWindowsNamespace(normalized[key]);
  }
  return normalized;
}

export function publicServer(server) {
  return {
    id: server.id,
    label: server.label,
    description: server.description,
    runtime: server.runtime,
    capabilities: runtimeCapabilities(server.runtime),
    transport: server.transport,
    host: server.transport === "ssh" ? server.host : undefined,
    workspacePath: stripWindowsNamespace(
      server.transport === "local" ? server.cwd : server.remoteCwd
    ),
    command: server.command,
    ...(server.security ? { security: server.security } : {}),
    ...(server.profile ? { profile: server.profile } : {}),
    ...(server.settingsFile ? { settingsFile: server.settingsFile } : {}),
    ...(server.chromiumBin ? { chromiumBin: server.chromiumBin } : {}),
    ...(server.chromiumNoSandbox ? { chromiumNoSandbox: true } : {}),
    ...(server.transport === "ssh" ? {
      user: server.user,
      port: server.port,
      acceptNewHostKey: server.acceptNewHostKey,
    } : {}),
  };
}

export function runtimeCapabilities(runtime) {
  if (runtime !== "kcoder") throw new Error(`unsupported runtime capabilities: ${runtime}`);
  return {
    browserSessions: true,
    fileChangesRevert: true,
    terminalSessions: true,
    workspaceFiles: true,
  };
}

export function storedServer(server) {
  const common = {
    id: server.id,
    label: server.label,
    description: server.description,
    runtime: server.runtime,
    transport: server.transport,
    ...(server.security ? { security: server.security } : {}),
  };
  if (server.transport === "local") {
    return normalizeServerEntryForSave({
      ...common,
      command: server.command,
      workspace: server.cwd,
      ...(server.settingsFile ? { settingsFile: server.settingsFile } : {}),
      ...(server.profile ? { profile: server.profile } : {}),
      ...(server.chromiumBin ? { chromiumBin: server.chromiumBin } : {}),
      ...(server.chromiumNoSandbox ? { chromiumNoSandbox: true } : {}),
    });
  }
  return normalizeServerEntryForSave({
    ...common,
    host: server.host,
    ...(server.user ? { user: server.user } : {}),
    ...(server.port ? { port: server.port } : {}),
    command: server.command,
    ...(server.remoteCwd ? { workspace: server.remoteCwd } : {}),
    ...(server.settingsFile ? { settingsFile: server.settingsFile } : {}),
    ...(server.profile ? { profile: server.profile } : {}),
    ...(server.chromiumBin ? { chromiumBin: server.chromiumBin } : {}),
    ...(server.chromiumNoSandbox ? { chromiumNoSandbox: true } : {}),
    ...(server.acceptNewHostKey ? { acceptNewHostKey: true } : {}),
  });
}

export function launchSpec(server, { scenario = "", workspacePath, platform = process.platform } = {}) {
  const paths = server.transport === "ssh" || platform !== "win32" ? posix : win32;
  if (scenario && !SAFE_ID.test(scenario)) throw new Error("invalid app-server scenario");
  if (workspacePath !== undefined && (typeof workspacePath !== "string" || workspacePath.length === 0 || workspacePath.length > 2048 || !paths.isAbsolute(workspacePath))) {
    throw new Error("invalid task workspace");
  }
  if (server.transport === "ssh" && workspacePath && !server.security && !SAFE_COMMAND.test(workspacePath)) {
    throw new Error("invalid remote task workspace");
  }
  const appArgs = [];
  if (server.security && scenario) throw new Error('scenarios are not allowed through account authentication');
  if (server.settingsFile) appArgs.push("--settings-file", server.settingsFile);
  if (server.profile) appArgs.push("--profile", server.profile);
  const effectiveWorkspace = workspacePath || server.remoteCwd;
  if (effectiveWorkspace) appArgs.push("--cwd", effectiveWorkspace);
  appArgs.push("app-server");
  if (scenario) appArgs.push("--scenario", scenario);
  const childEnv = {};
  if (server.chromiumBin) childEnv.KCODER_CHROMIUM_BIN = server.chromiumBin;
  if (server.chromiumNoSandbox) childEnv.KCODER_CHROMIUM_NO_SANDBOX = "1";
  if (server.transport === "local") {
    return {
      command: server.command,
      args: appArgs,
      cwd: stripWindowsNamespace(workspacePath ? paths.resolve(workspacePath) : server.cwd),
      ...(Object.keys(childEnv).length ? { env: childEnv } : {}),
    };
  }

  const destination = server.user ? `${server.user}@${server.host}` : server.host;
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (server.acceptNewHostKey) args.push("-o", "StrictHostKeyChecking=accept-new");
  if (server.port) args.push("-p", String(server.port));
  args.push(destination);
  if (Object.keys(childEnv).length) {
    args.push("env", ...Object.entries(childEnv).map(([name, value]) => `${name}=${value}`));
  }
  args.push(server.command, ...(server.security ? [] : appArgs));
  return {
    command: "ssh", args, cwd: undefined,
    // Win32 OpenSSH requires overlapped pipe handles to read Node child stdin.
    ...(platform === "win32" ? { stdio: ["overlapped", "overlapped", "overlapped"] } : {}),
  };
}

function safeLocalExecutable(command, paths) {
  // Local children use spawn(argv), never a shell. Absolute executable paths may
  // contain spaces and Unicode; SSH command strings retain their stricter rules.
  return typeof command === "string" && !/[\x00-\x1f\x7f]/.test(command)
    && (SAFE_COMMAND.test(command) || paths.isAbsolute(command));
}

export function appServerEnvironment(baseEnv, overrides = {}) {
  const childEnv = { ...baseEnv, ...overrides };
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("KCODER_STUDIO_") || name === "ELECTRON_RUN_AS_NODE") delete childEnv[name];
  }
  return childEnv;
}

function requiredString(value, name, max = 128) {
  const normalized = optionalString(value, max);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value, max = 128) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error("invalid string value");
  return value.trim();
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

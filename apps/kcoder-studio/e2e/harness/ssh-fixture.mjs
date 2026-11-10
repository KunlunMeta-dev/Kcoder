import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer, isIP } from "node:net";
import { delimiter, resolve } from "node:path";
import { userInfo, networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { requireExecutable, waitFor } from "./run-context.mjs";

const execFileAsync = promisify(execFile);

export function sshFixtureUser(explicitUser, environmentUser = process.env.USER) {
  return explicitUser || environmentUser || userInfo().username;
}

export function sshFixtureListenHost(explicitHost, interfaces = networkInterfaces()) {
  if (explicitHost === undefined) return '127.0.0.1';
  if (isIP(explicitHost) !== 4 || explicitHost === '0.0.0.0' ||
      !Object.values(interfaces).flat().some(entry => entry?.address === explicitHost)) {
    throw new Error('SSH fixture requires one explicit address on this host');
  }
  return explicitHost;
}

export async function startSshFixture(context, options = {}) {
  if (options.configDirectory !== undefined && (typeof options.configDirectory !== 'string'
      || !options.configDirectory.startsWith(context.stateDir + '/')
      || !/^\/[a-zA-Z0-9_./-]+$/.test(options.configDirectory))) {
    throw new Error('SSH fixture config directory must belong to this owned run');
  }
  if (options.forcedCommand && (resolve(options.forcedCommand) !== options.forcedCommand ||
      !options.forcedCommand.startsWith(context.stateDir + '/') ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(options.forcedCommand))) {
    throw new Error('SSH fixture forced command must be a simple owned state path');
  }
  const sshdBin = await requireExecutable(options.sshdBin || "/usr/sbin/sshd", "OpenSSH server");
  await requireExecutable("/usr/bin/ssh", "OpenSSH client");
  await requireExecutable("/usr/bin/ssh-keygen", "ssh-keygen");
  const root = context.pathInState("ssh");
  context.registerTemporaryDirectory("ssh", root);
  const binDir = resolve(root, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const user = sshFixtureUser(options.user);
  if (!user) throw new Error("UNMET_PREREQUISITE: current SSH test user is unknown");
  const listenHost = sshFixtureListenHost(options.listenHost);
  const reservation = await reservePort(listenHost);
  const port = reservation.port;
  context.registerPort("sshd", port);
  const hostKey = resolve(root, "host-key");
  const clientKey = resolve(root, "client-key");
  const authorizedKeys = resolve(root, "authorized_keys");
  const knownHosts = resolve(root, "known_hosts");
  const config = resolve(root, "sshd_config");
  await execFileAsync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  await execFileAsync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  await chmod(hostKey, 0o600);
  await chmod(clientKey, 0o600);
  await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`), { mode: 0o600 });
  const knownHost = options.strictKnownHost
    ? `[${listenHost}]:${port} ${(await readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0,2).join(' ')}\n` : '';
  await writeFile(knownHosts, knownHost, { mode: 0o600 });
  await writeFile(config, [
    `Port ${port}`,
    `ListenAddress ${listenHost}`,
    `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "UsePAM no",
    "StrictModes no",
    `AllowUsers ${user}`,
    `PidFile ${resolve(root, "sshd.pid")}`,
    "LogLevel VERBOSE",
    ...(options.configDirectory ? [`SetEnv KCODER_CONFIG_DIR=${options.configDirectory}`] : []),
    ...(options.forcedCommand ? [`ForceCommand ${options.forcedCommand}`] : []),
    "",
  ].join("\n"), { mode: 0o600 });
  const wrapper = resolve(binDir, "ssh");
  await writeFile(wrapper, [
    "#!/bin/sh",
    `exec /usr/bin/ssh -F /dev/null -i '${shellQuote(clientKey)}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=${options.strictKnownHost ? 'yes' : 'accept-new'} -o UserKnownHostsFile='${shellQuote(knownHosts)}' \"$@\"`,
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(wrapper, 0o700);
  await reservation.release();
  const child = context.spawnOwned("sshd", sshdBin, ["-D", "-e", "-f", config]);
  await waitForPort(port, 8_000, child, listenHost);
  return {
    child,
    port,
    user,
    root,
    listenHost,
    wrapperDir: binDir,
    gatewayEnv: { PATH: `${binDir}${delimiter}${process.env.PATH || ""}` },
  };
}

export async function reservePort(host) {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  let released = false;
  return {
    port: address.port,
    release: async () => {
      if (released) return;
      released = true;
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

async function waitForPort(port, timeoutMs, child, host) {
  await waitFor(() => new Promise(resolveProbe => {
    if (child.exitCode !== null) {
      resolveProbe(Promise.reject(new Error(`sshd exited with code ${child.exitCode}`)));
      return;
    }
    const socket = createConnection({ host, port });
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { socket.destroy(); resolveProbe(false); });
  }), timeoutMs, `sshd port ${port}`);
}

function shellQuote(value) {
  return value.replaceAll("'", "'\\''");
}

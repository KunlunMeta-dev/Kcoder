import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { delimiter, resolve } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { requireExecutable, waitFor } from "./run-context.mjs";

const execFileAsync = promisify(execFile);

export function sshFixtureUser(explicitUser, environmentUser = process.env.USER) {
  return explicitUser || environmentUser || userInfo().username;
}

export async function startSshFixture(context, options = {}) {
  const sshdBin = await requireExecutable(options.sshdBin || "/usr/sbin/sshd", "OpenSSH server");
  await requireExecutable("/usr/bin/ssh", "OpenSSH client");
  await requireExecutable("/usr/bin/ssh-keygen", "ssh-keygen");
  const root = context.pathInState("ssh");
  context.registerTemporaryDirectory("ssh", root);
  const binDir = resolve(root, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const user = sshFixtureUser(options.user);
  if (!user) throw new Error("UNMET_PREREQUISITE: current SSH test user is unknown");
  const reservation = await reservePort();
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
  await writeFile(knownHosts, "", { mode: 0o600 });
  await writeFile(config, [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
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
    "",
  ].join("\n"), { mode: 0o600 });
  const wrapper = resolve(binDir, "ssh");
  await writeFile(wrapper, [
    "#!/bin/sh",
    `exec /usr/bin/ssh -F /dev/null -i '${shellQuote(clientKey)}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${shellQuote(knownHosts)}' \"$@\"`,
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(wrapper, 0o700);
  await reservation.release();
  const child = context.spawnOwned("sshd", sshdBin, ["-D", "-e", "-f", config]);
  await waitForPort(port, 8_000, child);
  return {
    child,
    port,
    user,
    root,
    wrapperDir: binDir,
    gatewayEnv: { PATH: `${binDir}${delimiter}${process.env.PATH || ""}` },
  };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
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

async function waitForPort(port, timeoutMs, child) {
  await waitFor(() => new Promise(resolveProbe => {
    if (child.exitCode !== null) {
      resolveProbe(Promise.reject(new Error(`sshd exited with code ${child.exitCode}`)));
      return;
    }
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { socket.destroy(); resolveProbe(false); });
  }), timeoutMs, `sshd port ${port}`);
}

function shellQuote(value) {
  return value.replaceAll("'", "'\\''");
}

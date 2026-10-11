import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("ssh missing ControlPath fails without opening a fresh TCP connection", async () => {
  const controlDirectory = await mkdtemp(join(tmpdir(), "kc-ssh-mux-failclosed-"));
  const controlPath = join(controlDirectory, "control");
  await chmod(controlDirectory, 0o700);
  const connectionAttempts = [];
  const server = createServer(socket => {
    connectionAttempts.push(true);
    socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    let sshError = null;
    try {
      await execFileAsync("ssh", [
        "-F", "/dev/null",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=2",
        "-o", "ControlMaster=no",
        "-o", `ControlPath=${controlPath}`,
        "-o", "ProxyCommand=/bin/false",
        "-p", String(port),
        "-T", "fixture@127.0.0.1", "true",
      ], {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 8 * 1024,
      });
    } catch (error) {
      sshError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(sshError, "a missing ControlPath must fail the SSH request");
    assert.equal(sshError.code, 255, "the unavailable multiplex socket must fail as SSH, not hang until the test timeout");
    assert.equal(sshError.killed, false, "the focused fallback check must finish before its local timeout");
    assert.equal(connectionAttempts.length, 0, "a missing master must not fall back to a new TCP connection");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(controlDirectory, { recursive: true, force: true });
  }
});

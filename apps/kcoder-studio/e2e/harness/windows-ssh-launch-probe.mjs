import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [gatewayDirectory, host, user, workspace] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(
  gatewayDirectory && host && user && workspace,
  "Explicit installed Gateway and remote target are required",
);
const { launchSpec } = await import(
  pathToFileURL(resolve(gatewayDirectory, "src/server-config.js")).href
);
const spec = launchSpec({
  transport: "ssh",
  host,
  user,
  port: 22,
  command: "/usr/local/bin/kcoder",
  remoteCwd: workspace,
});
assert.deepEqual(spec.stdio, ["overlapped", "overlapped", "overlapped"]);
const started = Date.now();
const child = spawn(spec.command, spec.args, {
  stdio: spec.stdio,
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
child.stderr.resume();
let timer;
try {
  const response = await new Promise((resolveResponse, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error("Installed Gateway SSH initialization exceeded 12 seconds"),
        ),
      12000,
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`SSH exited before initialization: ${code}`)),
    );
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.id === 1) resolveResponse(value);
      } catch {}
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-27",
          clientInfo: { name: "windows-installed-ssh-qa", version: "1" },
        },
      }) + "\n",
    );
  });
  assert.equal(
    response.error,
    undefined,
    "Remote initialization returned an RPC error",
  );
  assert.ok(response.result);
  console.log(
    JSON.stringify({
      passed: true,
      installedLaunchSpec: true,
      nativeWindowsSsh: true,
      overlappedPipes: true,
      initializedMs: Date.now() - started,
    }),
  );
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)),
    ]);
    if (child.exitCode === null)
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }
}

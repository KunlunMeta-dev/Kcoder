import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, rename, lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnWindowsSupervised, stopSupervisedProcess } from "./owned-process.mjs";
import { makeOwnedCookieEnvironment, redactOwnedCookieOutput } from "./windows-cookie-environment.mjs";

const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
const root = resolve(configuration.root);
assert.equal(process.platform, "win32");
assert.equal(JSON.parse(await readFile(join(root, ".owner.json"), "utf8")).owner, configuration.owner);
const rootStat = await lstat(root, { bigint: true });
assert.equal(rootStat.isSymbolicLink(), false);
const rootIdentity = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
const birth = (pid) => JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${pid});try{$h=$p.Handle;@{pid=$p.Id;creationTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();sessionId=$p.SessionId}|ConvertTo-Json -Compress}finally{$p.Dispose()}`],
{ windowsHide: true, encoding: "utf8", timeout: 8_000 }).trim());
const controllerBirth = birth(process.pid);
assert.equal(controllerBirth.sessionId, 0);
async function publish(name, value, exclusive = false) {
  const path = join(root, name);
  if (exclusive) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); return; }
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(path + ".tmp", path);
}
await publish("controller-birth.json", { version: 1, owner: configuration.owner, rootIdentity, controllerBirth }, true);
let heartbeat = Date.now(), heartbeatCount = 0, revoked = false, finished = false, supervised, supervisorBirth, timer, deadline;
let acceptHeartbeat;
const firstHeartbeat = new Promise((resolve) => { acceptHeartbeat = resolve; });
const control = createInterface({ input: process.stdin });
function revoke() {
  if (finished || revoked) return;
  revoked = true;
  if (supervised) void stopSupervisedProcess(supervised.child, supervised.identity).catch(() => {});
}
control.on("line", (line) => {
  try {
    const value = JSON.parse(line);
    if (value.owner !== configuration.owner || value.command !== "HEARTBEAT") { revoke(); return; }
    heartbeat = Date.now();
    heartbeatCount++;
    acceptHeartbeat();
  } catch { revoke(); }
});
control.on("close", revoke);
timer = setInterval(() => { if (Date.now() - heartbeat > 12_000) revoke(); }, 1_000);
deadline = setTimeout(revoke, 45_000);
const receipt = { version: 1, owner: configuration.owner, rootIdentity, controllerBirth, supervisorSha256: configuration.supervisorSha256,
  jobEmpty: false, originalHandleClosed: false, failure: null };
try {
  let firstDeadline;
  try { await Promise.race([firstHeartbeat, new Promise((_, reject) => { firstDeadline = setTimeout(() => reject(new Error("Initial owner heartbeat missing")), 4_000); })]); }
  finally { clearTimeout(firstDeadline); }
  const helper = join(root, "supervisor.exe");
  assert.equal(createHash("sha256").update(await readFile(helper)).digest("hex"), configuration.supervisorSha256);
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = helper;
  const { directories: dirs, environment } = makeOwnedCookieEnvironment(process.env, root);
  for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
  await publish("electron-config.json", { owner: configuration.owner, sessionId: controllerBirth.sessionId, profile: dirs.profile,
    certificate: join(root, "certificate.pem"), key: join(root, "certificate-key.pem"), report: join(root, "cookie-report.json") }, true);
  assert.equal(revoked, false, "owner revoked before launch");
  supervised = spawnWindowsSupervised(join(root, "runtime", "electron-cookie.exe"), ["--headless", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--no-proxy-server", "--lang=en-US", "--host-resolver-rules=MAP owned-cookie.invalid 127.0.0.1, MAP * ~NOTFOUND",
    `--user-data-dir=${dirs.profile}`, `--disk-cache-dir=${dirs.cache}`, `--crash-dumps-dir=${join(dirs.profile, "crash")}`],
  { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }, join(root, "job-status"));
  let bytes = 0;
  let tail = "";
  for (const stream of [supervised.child.stdout, supervised.child.stderr]) stream.on("data", (part) => {
    bytes += part.length; tail = (tail + part.toString("utf8")).slice(-8_192);
    if (bytes > 128 * 1024) revoke();
  });
  supervised.identity.closedPromise.then(() => { receipt.nativeOutputTail = redactOwnedCookieOutput(tail, configuration.owner); receipt.outputBytes = bytes; });
  supervisorBirth = birth(supervised.child.pid);
  await publish("supervisor-birth.json", { owner: configuration.owner, controllerBirth, supervisorBirth, rootIdentity,
    nonce: supervised.identity.nonce, statusFile: supervised.identity.statusFile }, true);
  await supervised.identity.readyPromise;
  const closed = await supervised.identity.closedPromise;
  receipt.originalHandleClosed = true;
  const lines = (await readFile(supervised.identity.statusFile, "utf8")).split(/\r?\n/).slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0]?.event, "READY");
  assert.equal(lines[0]?.nonce, supervised.identity.nonce);
  assert.equal(lines.at(-1)?.event, "EXIT", "no authoritative Job-empty receipt");
  assert.equal(lines.filter((value) => value.event === "EXIT").length, 1);
  assert.equal(lines.some((value) => value.event === "ERROR"), false);
  assert.equal(lines.at(-1).code, closed.code);
  Object.assign(receipt, { supervisorBirth, nonce: supervised.identity.nonce, statusEvents: lines, jobEmpty: true, helperCloseCode: closed.code,
    ownershipRevoked: revoked, heartbeatCount, outputBytes: bytes });
  await publish("job-empty-receipt.json", receipt, true);
  assert.equal(revoked, false, "owner authority revoked");
  assert.equal(closed.code, 0, "Cookie fixture failed");
  const report = JSON.parse(await readFile(join(root, "cookie-report.json"), "utf8"));
  assert.equal(report.owner, configuration.owner);
  assert.equal(report.failure, null);
  assert.equal(report.cases.length, 3);
  assert.equal(report.browserWindowsCreated, 0);
} catch (error) {
  receipt.failure = String(error.message || error).slice(0, 500);
  if (supervised && !supervised.identity.closed) {
    try { await stopSupervisedProcess(supervised.child, supervised.identity); }
    catch { receipt.stopUnconfirmed = true; }
  }
  process.exitCode = 1;
} finally {
  finished = true;
  clearInterval(timer); clearTimeout(deadline);
  await publish("controller-result.json", receipt);
  control.close(); process.stdin.destroy();
  console.log(JSON.stringify({ owner: configuration.owner, passed: !receipt.failure, jobEmpty: receipt.jobEmpty, originalHandleClosed: receipt.originalHandleClosed }));
}

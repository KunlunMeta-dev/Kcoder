import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

// Every Windows boundary here is synthetic; all pipes and child exits are real local Node resources.
const [mode, value = "", argument = ""] = process.argv.slice(2);
if (mode === "output") process.stdout.end(value);
else if (mode === "hold") setInterval(() => {}, 1000);
else if (mode === "exit") process.exit(23);
else if (mode === "signal") process.kill(process.pid, "SIGTERM");
else if (mode === "closed-stdin") {
  setInterval(() => {}, 1000); closeSync(0); process.stdout.write("stdin-closed\n");
} else if (mode === "worker") {
  process.stdout.write(JSON.stringify({ fixtureEvent: "worker-ready" }) + "\n");
  if (value === "normal-zero") setTimeout(() => process.exit(0), 100);
  else {
    process.stdin.resume();
    process.stdin.once("end", () => setTimeout(() => process.exit(0), 40));
  }
} else if (mode === "ui-driver" || mode === "ui-driver-lease-close") {
  const source = value, inputFile = argument, localRoot = join(inputFile, "..");
  const input = JSON.parse(await readFile(inputFile, "utf8"));
  const event = row => process.stdout.write(JSON.stringify(row) + "\n");
  let supervisedChild, supervisorStarts = 0;
  const rescue = () => {
    if (!supervisedChild || supervisedChild.exitCode !== null || supervisedChild.signalCode !== null) return;
    supervisedChild.stdin.destroy();
    supervisedChild.kill("SIGTERM");
  };
  process.once("exit", rescue);
  process.once("SIGTERM", () => { rescue(); process.exitCode = 2; });
  const spawnWindowsSupervised = () => {
    supervisorStarts++;
    supervisedChild = spawn(process.execPath, [...process.execArgv, process.argv[1], "worker", input.fixtureWorkerMode ?? "zero-after-eof"], { stdio: ["pipe", "pipe", "pipe"], detached: false });
    // Retain the original ChildProcess immediately, before any awaited readiness or injected EOF.
    supervisedChild.once("error", error => event({ fixtureEvent: "supervisor-error", code: error.code }));
    supervisedChild.stdin.on("error", error => event({ fixtureEvent: "supervisor-write-error", code: error.code }));
    supervisedChild.once("close", (code, signal) => event({ fixtureEvent: "supervisor-closed", code, signal }));
    const readyPromise = new Promise((resolve, reject) => {
      supervisedChild.once("error", reject);
      supervisedChild.once("close", (code, signal) => reject(new Error(`Local supervisor fixture closed before readiness (${signal || code})`)));
      supervisedChild.stdout.once("data", () => resolve({ pid: supervisedChild.pid }));
    });
    event({ fixtureEvent: "supervisor-spawned", pid: supervisedChild.pid });
    return { child: supervisedChild, identity: { readyPromise } };
  };
  const processView = Object.create(process);
  Object.defineProperties(processView, {
    platform: { value: "win32" }, argv: { value: [process.execPath, source, inputFile] },
    exitCode: { get: () => process.exitCode, set: value => { process.exitCode = value; } },
  });
  const context = createContext({ process: processView, Buffer, setTimeout, clearTimeout, console });
  const module = new SourceTextModule(await readFile(source, "utf8"), {
    context, identifier: pathToFileURL(source).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(source).href; },
  });
  await module.link(async specifier => {
    let exports;
    if (specifier === "./owned-process.mjs") exports = { spawnWindowsSupervised };
    else if (specifier === "node:child_process") exports = { execFileSync: () => "123456789" };
    else if (specifier === "node:fs/promises") exports = {
      readFile: (path, ...args) => readFile(path === inputFile ? inputFile : join(localRoot, basename(path)), ...args),
      writeFile: (path, ...args) => writeFile(join(localRoot, basename(path)), ...args),
    };
    else if (specifier === "node:readline" && mode === "ui-driver-lease-close") exports = {
      createInterface(options) {
        const reader = createInterface(options), once = reader.once.bind(reader);
        reader.once = (name, callback) => once(name, name === "line" ? line => { callback(line); reader.close(); } : callback);
        return reader;
      },
    };
    else exports = await import(specifier);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  try {
    await module.evaluate();
    event({ fixtureEvent: "module-evaluated", supervisorStarts, wrapperExitCode: process.exitCode ?? 0 });
  } catch (error) {
    event({ fixtureEvent: "module-failed", supervisorStarts, message: error.message });
    process.exitCode ||= 1;
  } finally { rescue(); process.stdin.destroy(); }
} else throw new Error("Unsupported wrapper fault fixture mode");

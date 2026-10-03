import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [root, market, proxy = "", names = ""] = process.argv.slice(2);
if (!root || !/^[a-z0-9-]+$/.test(market))
  throw new Error("Explicit owned root and market required");
await readFile(join(root, "owned-matrix.json"), "utf8");
const presets = JSON.parse(
  await readFile(join(root, "marketplaces.json"), "utf8"),
);
const preset = presets.find((value) => value.id === market);
if (!preset) throw new Error("Unknown market");
const profile = join(root, `profile-${market}`),
  workspace = join(root, `workspace-${market}`);
await mkdir(profile, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    providers: {},
    plugins: {
      installation: {
        timeout_ms: 120000,
        ...(proxy ? { proxy_url: proxy } : {}),
      },
    },
  }),
);
const bypass =
  "localhost,127.0.0.1,p11-market.byteimg.com,qoder-skills.oss-accelerate.aliyuncs.com,qoder-mind.oss-accelerate.aliyuncs.com";
const child = spawn(
  join(root, "kcoder.exe"),
  [
    "--settings-file",
    join(profile, "settings.json"),
    "--cwd",
    workspace,
    "app-server",
  ],
  {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      KCODER_CONFIG_DIR: profile,
      NO_PROXY: bypass,
      no_proxy: bypass,
    },
  },
);
let sequence = 0,
  stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
child.on("exit", (code) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`Backend exited ${code}`));
  }
  pending.clear();
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.method) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error
      ? request.reject(new Error(message.error.message))
      : request.resolve(message.result);
  } catch (error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
});
function rpc(method, params = {}, timeout = 150000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC_TIMEOUT ${method}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}
const redact = (error) =>
  String(error?.message ?? error)
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[redacted]");
const report = (kind, value) => console.log(kind + " " + JSON.stringify(value));
let failures = 0;
try {
  await rpc("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "full-windows-plugin-matrix", version: "2" },
  });
  const added = await rpc("marketplace/add", { source: preset.url });
  const mid = added.marketplaceName;
  const catalog = await rpc("marketplace/list");
  const selected = catalog.marketplaces.find((value) => value.id === mid);
  if (!selected) throw new Error("Missing imported market");
  let entries = selected.plugins;
  if (names) {
    const wanted = names.split(",");
    entries = entries.filter((value) =>
      wanted.includes(value.pluginId.slice(0, value.pluginId.lastIndexOf("@"))),
    );
    if (entries.length !== wanted.length)
      throw new Error("Requested plugin is absent from catalog");
  }
  report("CATALOG", {
    market,
    catalog: mid,
    total: entries.length,
    source: preset.url,
    capturedAt: new Date().toISOString(),
    diagnostics: catalog.diagnostics,
    plugins: entries.map((item) => ({
      id: item.pluginId,
      version: item.version,
      policy: item.installPolicy,
    })),
  });
  for (const [index, entry] of entries.entries()) {
    const id = entry.pluginId,
      name = id.slice(0, id.lastIndexOf("@"));
    const row = {
      market,
      index: index + 1,
      total: entries.length,
      id,
      status: "pending",
    };
    if (String(entry.installPolicy).toLowerCase() === "not_available") {
      row.status = "not_available";
      row.reason = "catalog policy";
      report("RESULT", row);
      continue;
    }
    let installed = false;
    const start = Date.now(),
      attempt = `all-${market}-${index}`;
    try {
      const result = await rpc("plugin/install", {
        marketplaceName: mid,
        pluginName: name,
        installAttemptId: attempt,
      });
      installed = true;
      const read = await rpc("plugin/read", { pluginId: id });
      if (read.plugin.id !== id) throw new Error("Installed identity mismatch");
      row.status = "installed";
      row.version = read.plugin.version;
      row.components = read.plugin.components.map((value) => ({
        name: value.name,
        kind: value.kind,
      }));
      row.compatibility = read.plugin.compatibility;
      row.diagnostics = read.diagnostics;
      try {
        const icon = await rpc("plugin/icon", { pluginId: id });
        row.icon = !icon.url
          ? "none_declared"
          : icon.url.startsWith("data:image/")
            ? "embedded_image"
            : icon.url.startsWith("https://")
              ? "declared_https"
              : "unexpected_format";
      } catch (error) {
        row.icon = "error";
        row.iconError = redact(error);
      }
    } catch (error) {
      row.status = "failed";
      row.error = redact(error);
      failures++;
      if (row.error.startsWith("RPC_TIMEOUT"))
        await rpc(
          "plugin/install/cancel",
          { installAttemptId: attempt },
          15000,
        ).catch(() => {});
    } finally {
      if (installed) {
        try {
          await rpc("plugin/uninstall", { pluginId: id, purgeData: true });
          row.uninstalled = true;
        } catch (error) {
          row.status = "failed";
          row.cleanupError = redact(error);
          failures++;
        }
      }
    }
    row.durationMs = Date.now() - start;
    report("RESULT", row);
  }
  report("SUMMARY", { market, tested: entries.length, failures });
} catch (error) {
  report("FATAL", { market, error: redact(error) });
  failures++;
} finally {
  lines.close();
  child.stdin.end();
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) {
      const stop = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      await new Promise((resolve) => stop.once("exit", resolve));
    }
  }
  for (const request of pending.values()) {
    clearTimeout(request.timer);
  }
  pending.clear();
}
process.exitCode = failures ? 1 : 0;

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";
const target = process.env.KCODER_E2E_WINDOWS_SSH;
if (
  process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== "1" ||
  !target ||
  !/^[a-zA-Z0-9@._-]+$/.test(target)
)
  throw new Error("Explicit Windows SSH target and public access required");
const proxy = process.env.KCODER_E2E_WINDOWS_PROXY || "";
const names = process.env.KCODER_E2E_MATRIX_NAMES || "";
const retestPath = process.env.KCODER_E2E_MATRIX_RETEST_FILE;
const retest = retestPath
  ? JSON.parse(await readFile(retestPath, "utf8"))
  : null;
if (retest)
  for (const entries of Object.values(retest)) {
    if (
      !Array.isArray(entries) ||
      entries.some(
        (name) => typeof name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(name),
      )
    )
      throw new Error("Invalid retest names");
  }
if (names && !/^[a-zA-Z0-9._-]+(,[a-zA-Z0-9._-]+)*$/.test(names))
  throw new Error("Invalid plugin names");
if (proxy) {
  const url = new URL(proxy);
  if (
    !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9:/.\[\]_-]+$/.test(proxy)
  )
    throw new Error("Invalid test proxy");
}
const ps = (script) =>
  "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
  Buffer.from(
    "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
      script,
    "utf16le",
  ).toString("base64");
await runE2E(
  import.meta.url,
  {
    testId: "all-marketplaces-windows-installation",
    tier: "manual-live",
    cleanupTimeoutMs: 60000,
    modelPolicy:
      "all public catalog entries, isolated real Windows installation/read/icon/uninstall; no model, hooks, MCP service calls or user credentials",
  },
  async (context) => {
    const nonce = randomBytes(8).toString("hex");
    let sequence = 0;
    let root;
    const exec = async (label, program, args, onLine) => {
      const child = context.spawnOwned(`${label}-${sequence++}`, program, args);
      let output = "",
        buffer = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          onLine?.(line);
        }
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      return { code, output };
    };
    const setup = await exec("setup", "ssh", [
      "-o",
      "BatchMode=yes",
      target,
      ps(
        `$r=Join-Path $env:TEMP 'kcoder-all-${nonce}';if(Test-Path $r){throw 'Root exists'};[IO.Directory]::CreateDirectory($r)|Out-Null;[IO.File]::WriteAllText((Join-Path $r 'owned-matrix.json'),'${nonce}');Write-Output $r`,
      ),
    ]);
    assert.equal(setup.code, 0);
    root = setup.output.trim().replaceAll("\\", "/");
    assert.match(root, new RegExp(`^[A-Za-z]:/[^\r\n']*/kcoder-all-${nonce}$`));
    const cleanupEnvironment = context.isolatedEnvironment();
    context.addCleanup("remove owned remote test resources", async () => {
      await execFileAsync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          target,
          ps(
            `$r='${root}';if((Get-Content -LiteralPath (Join-Path $r 'owned-matrix.json') -Raw) -ne '${nonce}'){throw 'Wrong owner'};Get-CimInstance Win32_Process -Filter "name='kcoder.exe'"|Where-Object {$_.ExecutablePath -eq ($r.Replace('/','\\')+'\\kcoder.exe')}|ForEach-Object {& taskkill.exe /PID $_.ProcessId /T /F|Out-Null};& cmd.exe /d /c ('rd /s /q "\\\\?\\'+$r.Replace('/','\\')+'"');if(Test-Path $r){throw 'Remote cleanup failed'}`,
          ),
        ],
        { timeout: 45000, env: cleanupEnvironment },
      );
    });
    const binary = resolve(
      repoRoot,
      "target/x86_64-pc-windows-gnu/release/kcoder.exe",
    );
    await context.writeArtifactJson("binary.json", {
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      target,
      root,
    });
    for (const [file, name] of [
      [binary, "kcoder.exe"],
      [
        resolve(
          repoRoot,
          "target/x86_64-pc-windows-gnu/release/kcoder-process-supervisor.exe",
        ),
        "kcoder-process-supervisor.exe",
      ],
      [
        resolve(appRoot, "e2e/fixtures/windows/plugin-install-all.mjs"),
        "matrix.mjs",
      ],
      [
        resolve(
          appRoot,
          "renderer/src/features/plugins/marketplacePresets.json",
        ),
        "marketplaces.json",
      ],
    ]) {
      assert.equal(
        (await exec("upload", "scp", ["-q", file, `${target}:${root}/${name}`]))
          .code,
        0,
      );
    }
    const presets = JSON.parse(
      await readFile(
        resolve(
          appRoot,
          "renderer/src/features/plugins/marketplacePresets.json",
        ),
        "utf8",
      ),
    );
    const requested = process.env.KCODER_E2E_MATRIX_MARKETS?.split(",");
    const order = [
      "trae-cn",
      "qoder",
      "codebuddy",
      "workbuddy",
      "workbuddy-teams",
      "claude",
      "openai",
      "xai",
      "anthropic-skills",
      "superpowers",
    ];
    const queue = presets
      .filter(
        (p) =>
          (!requested || requested.includes(p.id)) &&
          (!retest || retest[p.id]?.length),
      )
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const reports = [];
    const worker = async () => {
      for (;;) {
        const market = queue.shift();
        if (!market) return;
        const report = { market: market.id, entries: [] };
        assert.match(market.id, /^[a-z0-9-]+$/);
        const args = [
          "-o",
          "BatchMode=yes",
          target,
          ps(
            `& node.exe '${root}/matrix.mjs' '${root}' '${market.id}' '${proxy}' '${retest ? retest[market.id].join(",") : names}'`,
          ),
        ];
        const result = await exec(
          `matrix-${market.id}`,
          "ssh",
          args,
          (line) => {
            for (const prefix of ["CATALOG ", "RESULT ", "SUMMARY ", "FATAL "])
              if (line.startsWith(prefix)) {
                const value = JSON.parse(line.slice(prefix.length));
                if (prefix === "CATALOG ") report.catalog = value;
                else if (prefix === "SUMMARY ") report.summary = value;
                else if (prefix === "FATAL ") report.fatal = value;
                else {
                  report.entries.push(value);
                  console.log(
                    JSON.stringify({
                      market: market.id,
                      index: value.index,
                      total: value.total,
                      id: value.id,
                      status: value.status,
                      error: value.error,
                      components: value.components?.length,
                    }),
                  );
                }
              }
          },
        );
        report.exitCode = result.code;
        reports.push(report);
        await context.writeArtifactJson(`matrix-${market.id}.json`, report);
      }
    };
    await Promise.all([worker(), worker()]);
    await context.writeArtifactJson("all-marketplaces.json", reports);
    assert.ok(
      reports.every(
        (report) =>
          report.catalog && report.entries.length === report.catalog.total,
      ),
      "Incomplete catalog coverage",
    );
    assert.ok(
      reports.every((report) => report.exitCode === 0),
      "Failures recorded; inspect all-marketplaces.json",
    );
  },
);

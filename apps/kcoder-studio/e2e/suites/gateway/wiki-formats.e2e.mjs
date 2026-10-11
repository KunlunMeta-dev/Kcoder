import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runE2E, repoRoot, appRoot } from "../../harness/run-context.mjs";
const execFileAsync = promisify(execFile);
await runE2E(
  import.meta.url,
  {
    testId: "wiki-format-full-chain",
    tier: "manual-live",
    cleanupTimeoutMs: 60000,
    modelPolicy:
      "Real format extraction and Wiki persistence with deterministic Provider; not real-model vision quality",
  },
  async (context) => {
    const password = process.env.KCODER_E2E_WINDOWS_PASSWORD;
    if (password) context.registerSecret(password);
    const sshEnv = () =>
      context.isolatedEnvironment(
        password
          ? {
              SSH_ASKPASS: resolve(appRoot, "e2e/fixtures/wiki/ssh-askpass.py"),
              SSH_ASKPASS_REQUIRE: "force",
              DISPLAY: ":0",
              KCODER_E2E_WINDOWS_PASSWORD: password,
            }
          : {},
      );
    const batchMode = password ? "BatchMode=no" : "BatchMode=yes";
    const root = context.pathInState("matrix");
    await mkdir(root, { recursive: true });
    await context.writeStateJson("matrix/owned.json", {
      nonce: randomBytes(8).toString("hex"),
    });
    const run = async (label, program, args, options = {}) => {
      const child = context.spawnOwned(
        label,
        program,
        args,
        ["ssh", "scp"].includes(program)
          ? { ...options, env: sshEnv() }
          : options,
      );
      return await new Promise((done, fail) => {
        child.once("error", fail);
        child.once("exit", (code) => done(code));
      });
    };
    assert.equal(
      await run(
        "generate",
        "/root/.local/bin/uv",
        [
          "run",
          "--python",
          "/usr/bin/python3",
          "--with",
          "python-docx==1.2.0",
          "--with",
          "python-pptx==1.0.2",
          "--with",
          "openpyxl==3.1.5",
          "--with",
          "XlsxWriter==3.2.5",
          "--with",
          "reportlab==4.4.0",
          "--with",
          "pillow==11.3.0",
          "--with",
          "msoffcrypto-tool==5.4.2",
          resolve(appRoot, "e2e/fixtures/wiki/generate-formats.py"),
          join(root, "samples"),
        ],
        {
          env: context.isolatedEnvironment({
            HTTPS_PROXY: "http://10.31.7.10:10809",
            HTTP_PROXY: "http://10.31.7.10:10809",
            UV_CACHE_DIR: context.pathInState("uv-cache"),
          }),
        },
      ),
      0,
    );
    if (process.env.KCODER_E2E_WIKI_CASES) {
      const names = process.env.KCODER_E2E_WIKI_CASES.split(",");
      const path = join(root, "samples", "manifest.json");
      const all = JSON.parse(await readFile(path, "utf8"));
      const selected = all.filter((c) => names.includes(c.name));
      assert.equal(selected.length, names.length);
      await writeFile(path, JSON.stringify(selected));
    }
    const code = await run("local-matrix", process.execPath, [
      resolve(appRoot, "e2e/fixtures/wiki/format-worker.mjs"),
      root,
      process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/release/kcoder"),
    ]);
    const local = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
    await context.writeArtifactJson("local-formats.json", local);
    const target = process.env.KCODER_E2E_WINDOWS_SSH;
    if (target) {
      assert.match(target, /^[a-zA-Z0-9@._-]+$/);
      const nonce = randomBytes(8).toString("hex");
      const ps = (s) =>
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
        Buffer.from(
          "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            s,
          "utf16le",
        ).toString("base64");
      const setup = await execFileAsync(
        "ssh",
        [
          "-o",
          batchMode,
          target,
          ps(
            `$r=Join-Path $env:TEMP 'kcoder-wiki-${nonce}';if(Test-Path $r){throw 'Root exists'};New-Item -ItemType Directory -Path $r|Out-Null;[IO.File]::WriteAllText((Join-Path $r 'owned.json'),'${nonce}');Write-Output $r`,
          ),
        ],
        { env: sshEnv(), timeout: 30000 },
      );
      const remote = setup.stdout.trim().replaceAll("\\", "/");
      assert.match(
        remote,
        new RegExp(`^[A-Za-z]:/[^\r\n']*/kcoder-wiki-${nonce}$`),
      );
      const cleanupEnv = sshEnv();
      await context.writeArtifactJson("windows-target.json", {
        target,
        root: remote,
      });
      context.addCleanup("owned Windows Wiki root", () =>
        execFileAsync(
          "ssh",
          [
            "-o",
            batchMode,
            target,
            ps(
              `$r='${remote}';if((Get-Content -LiteralPath (Join-Path $r 'owned.json') -Raw) -ne '${nonce}'){throw 'Wrong owner'};Get-CimInstance Win32_Process -Filter "name='kcoder.exe'"|Where-Object {$_.ExecutablePath -eq ([IO.Path]::GetFullPath((Join-Path $r 'kcoder.exe')))}|ForEach-Object {& taskkill.exe /PID $_.ProcessId /T /F|Out-Null};Remove-Item -LiteralPath $r -Recurse -Force`,
            ),
          ],
          { timeout: 45000, env: cleanupEnv },
        ),
      );
      const stage = context.pathInState("windows");
      await mkdir(join(stage, "e2e/fixtures/wiki"), { recursive: true });
      await mkdir(join(stage, "e2e/harness"), { recursive: true });
      for (const name of [
        "rpc.mjs",
        "header-websocket.mjs",
        "approval-model.mjs",
      ])
        await cp(
          resolve(appRoot, "e2e/harness", name),
          join(stage, "e2e/harness", name),
        );
      await cp(
        resolve(appRoot, "e2e/fixtures/wiki/format-worker.mjs"),
        join(stage, "e2e/fixtures/wiki/format-worker.mjs"),
      );
      await cp(join(root, "samples"), join(stage, "samples"), {
        recursive: true,
      });
      await cp(
        process.env.KCODER_E2E_WINDOWS_KCODER_BIN ||
          resolve(repoRoot, "target/x86_64-pc-windows-gnu/release/kcoder.exe"),
        join(stage, "kcoder.exe"),
      );
      await cp(
        resolve(
          repoRoot,
          "target/packages/kcoder-studio/windows-input/bin/pdf",
        ),
        join(stage, "pdf"),
        { recursive: true },
      );
      const archive = context.pathInState("windows-payload.tar.gz");
      assert.equal(
        await run("windows-pack", "tar", ["-czf", archive, "-C", stage, "."]),
        0,
      );
      assert.equal(
        await run("windows-upload", "scp", [
          "-q",
          archive,
          `${target}:${remote}/payload.tar.gz`,
        ]),
        0,
      );
      assert.equal(
        await run("windows-unpack", "ssh", [
          "-o",
          batchMode,
          target,
          ps(
            `& tar.exe -xzf '${remote}/payload.tar.gz' -C '${remote}';exit $LASTEXITCODE`,
          ),
        ]),
        0,
      );
      const windowsCode = await run("windows-matrix", "ssh", [
        "-o",
        batchMode,
        target,
        ps(
          `& node.exe '${remote}/e2e/fixtures/wiki/format-worker.mjs' '${remote}' '${remote}/kcoder.exe';exit $LASTEXITCODE`,
        ),
      ]);
      const output = context.pathInState("windows-report.json");
      assert.equal(
        await run("windows-report", "scp", [
          "-q",
          `${target}:${remote}/report.json`,
          output,
        ]),
        0,
      );
      const windows = JSON.parse(await readFile(output, "utf8"));
      await context.writeArtifactJson("windows-formats.json", windows);
      assert.equal(
        windowsCode,
        0,
        "Windows core formats failed; inspect report",
      );
    }
    assert.equal(code, 0, "Local core formats failed; inspect report");
  },
);

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { artifactSourceRoot, RunContext } from "./run-context.mjs";
import { listWorkspaceTemplates, materializeWorkspace } from "./workspace-fixture.mjs";

const execFileAsync = promisify(execFile);

test("模板目录提供五种稳定工作区", async () => {
  const templates = await listWorkspaceTemplates();
  assert.deepEqual(templates.map(template => template.id), [
    "broken-project",
    "git-history",
    "minimal",
    "rust-project",
    "typescript-app",
  ]);
  assert.ok(templates.every(template => template.version === 2));
});

test("copy 模板被物化为互不影响的独立可写副本", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-copy-fixture" });
  try {
    const first = await materializeWorkspace(context, "minimal", { instanceId: "minimal-a" });
    const second = await materializeWorkspace(context, "minimal", { instanceId: "minimal-b" });
    assert.match(await readFile(`${first.path}/README.md`, "utf8"), /KCoder E2E/);
    await assert.rejects(access(`${first.path}/.fixture.json`), error => error?.code === "ENOENT");
    await writeFile(`${first.path}/LOCAL_ONLY.txt`, "first\n");
    await assert.rejects(access(`${second.path}/LOCAL_ONLY.txt`), error => error?.code === "ENOENT");
    assert.match(first.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("git-history 模板生成可复现的两次提交且不复制 stage 元数据", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-git-fixture" });
  try {
    const fixture = await materializeWorkspace(context, "git-history", { instanceId: "history-a" });
    const duplicate = await materializeWorkspace(context, "git-history", { instanceId: "history-b" });
    const { stdout } = await execFileAsync("git", ["-C", fixture.path, "log", "--format=%s"], { encoding: "utf8" });
    assert.deepEqual(stdout.trim().split("\n"), ["feat: add subtraction", "chore: initialize calculator"]);
    assert.equal((await readFile(`${fixture.path}/src/calculator.js`, "utf8")).includes("subtract"), true);
    await assert.rejects(access(`${fixture.path}/stages`), error => error?.code === "ENOENT");
    assert.match(fixture.gitHead, /^[a-f0-9]{40}$/);
    assert.equal(duplicate.gitHead, fixture.gitHead);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("语言与故障模板具备预期的可执行基线", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-language-fixtures" });
  try {
    const typescript = await materializeWorkspace(context, "typescript-app");
    const rust = await materializeWorkspace(context, "rust-project");
    const broken = await materializeWorkspace(context, "broken-project");
    assert.match(await readFile(`${typescript.path}/src/temperature.ts`, "utf8"), /celsiusToFahrenheit/);
    const cargoTarget = context.pathInState("cargo-target");
    context.registerTemporaryDirectory("cargo-target", cargoTarget);
    await execFileAsync("cargo", ["test", "--quiet", "--manifest-path", `${rust.path}/Cargo.toml`], {
      timeout: 30_000,
      env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
    });
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const brokenFailure = await execFileAsync(
      process.execPath,
      ["--test", `${broken.path}/test/divide.test.js`],
      { cwd: broken.path, timeout: 10_000, env: childEnv },
    ).then(() => null, error => error);
    assert.ok(brokenFailure, "broken-project 的基线测试必须失败");
    assert.equal(Number(brokenFailure.code), 1);
    assert.match(`${brokenFailure.stdout}\n${brokenFailure.stderr}`, /rejects division by zero/);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("模板与实例 ID 不能路径穿越或覆盖现有工作区", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-boundaries" });
  try {
    await assert.rejects(materializeWorkspace(context, "../minimal"), /模板 ID 不合法/);
    await assert.rejects(materializeWorkspace(context, "minimal", { instanceId: "../escape" }), /实例 ID 不合法/);
    await materializeWorkspace(context, "minimal", { instanceId: "same" });
    await assert.rejects(materializeWorkspace(context, "minimal", { instanceId: "same" }), /拒绝覆盖/);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test.after(async () => {
  await rm(artifactSourceRoot(new URL(import.meta.url).pathname), { recursive: true, force: true });
});

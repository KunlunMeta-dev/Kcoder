import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunContext } from "./run-context.mjs";
import { listWorkspaceTemplates, materializeWorkspace } from "./workspace-fixture.mjs";

const execFileAsync = promisify(execFile);

test("模板目录提供七种稳定工作区", async () => {
  const templates = await listWorkspaceTemplates();
  assert.deepEqual(templates.map(template => template.id), [
    "broken-project",
    "git-history",
    "kworker-office",
    "minimal",
    "native-business",
    "rust-project",
    "typescript-app",
  ]);
  assert.ok(templates.every(template => template.version === (["kworker-office", "native-business"].includes(template.id) ? 1 : 2)));
});

test("business workspace owns its local guide without copying developer instructions or answers", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-native-business-guide" });
  try {
    const fixture = await materializeWorkspace(context, "native-business");
    const guide = await readFile(`${fixture.path}/AGENTS.md`, "utf8");
    assert.match(guide, /Synthetic business workspace/);
    assert.ok(Buffer.byteLength(guide) < 1024);
    assert.doesNotMatch(guide, /kcoder_cli|CARGO_TARGET_DIR|changed_R2|completed_units|200|180/);
    assert.match(await readFile(`${fixture.path}/README.md`, "utf8"), /no source answers/);
    assert.match(fixture.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await context.finish("passed", { ok: true });
  }
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
    const templateStage = fileURLToPath(new URL("../fixtures/workspaces/git-history/stages/01-initial/src/calculator.js", import.meta.url));
    const templateBefore = await readFile(templateStage);
    const fixture = await materializeWorkspace(context, "git-history", { instanceId: "history-a" });
    const duplicate = await materializeWorkspace(context, "git-history", { instanceId: "history-b" });
    const { stdout } = await execFileAsync("git", ["-C", fixture.path, "log", "--format=%s"], { encoding: "utf8" });
    assert.deepEqual(stdout.trim().split("\n"), ["feat: add subtraction", "chore: initialize calculator"]);
    assert.equal((await readFile(`${fixture.path}/src/calculator.js`, "utf8")).includes("subtract"), true);
    await assert.rejects(access(`${fixture.path}/stages`), error => error?.code === "ENOENT");
    assert.match(fixture.gitHead, /^[a-f0-9]{40}$/);
    assert.equal(duplicate.gitHead, fixture.gitHead);
    assert.deepEqual(await readFile(templateStage), templateBefore, "materialization must not mutate the read-only source stages");
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("并发 owned runs 的 Git 工作区互相隔离，结束一个 run 不会清除另一个", async t => {
  const firstContext = await RunContext.create(import.meta.url, { testId: "workspace-concurrent-first" });
  const contexts = [firstContext];
  t.after(async () => {
    for (const context of contexts) {
      if (!context.finished) await context.finish("failed", { testCleanup: true }).catch(() => {});
    }
    await Promise.all(contexts.map(context => rm(context.runRoot, { recursive: true, force: true })));
  });
  const secondContext = await RunContext.create(import.meta.url, { testId: "workspace-concurrent-second" });
  contexts.push(secondContext);
  const first = await materializeWorkspace(firstContext, "git-history");
  const second = await materializeWorkspace(secondContext, "git-history");
  assert.notEqual(firstContext.runRoot, secondContext.runRoot);
  assert.notEqual(first.path, second.path);
  await writeFile(resolve(first.path, "FIRST_ONLY.txt"), "first\n");
  await writeFile(resolve(second.path, "SECOND_ONLY.txt"), "second\n");

  await firstContext.finish("passed", { workspace: first.path });
  assert.equal(await readFile(resolve(second.path, "SECOND_ONLY.txt"), "utf8"), "second\n");
  await assert.rejects(access(first.path), { code: "ENOENT" });
  await assert.rejects(access(resolve(second.path, "FIRST_ONLY.txt")), { code: "ENOENT" });
  assert.match(second.gitHead, /^[a-f0-9]{40}$/);
  await secondContext.finish("passed", { workspace: second.path });
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

// RunContext retention owns completed evidence; never remove peer runs for this source.

test("office模板物化本地可核对资料，不包含凭据且不改原始样本", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "workspace-office-fixture" });
  try {
    const fixture = await materializeWorkspace(context, "kworker-office");
    assert.match(await readFile(resolve(fixture.path, "sources/sales.csv"), "utf8"), /Q4,189,110,33/);
    assert.match(await readFile(resolve(fixture.path, "sources/pilot-a.md"), "utf8"), /50 minutes to 35 minutes/);
    // These exact Markdown inputs must also survive the public source snapshot filter.
    for (const file of ["README.md", "sources/meeting.md", "sources/pilot-a.md", "sources/pilot-b.md", "sources/presentation.md"]) {
      assert.ok((await readFile(resolve(fixture.path, file), "utf8")).trim().length > 0, file);
    }
    await assert.rejects(access(resolve(fixture.path, "credentials.json")), {code:"ENOENT"});
  } finally { await context.finish("passed", {ok:true}); }
});

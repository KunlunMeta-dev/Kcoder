import assert from "node:assert/strict";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repoRoot } from "../harness/run-context.mjs";
import { minuteBoundaryOriginal, readOriginalMinuteBoundarySource } from "../harness/private-mobile-minute-boundary-original-source.mjs";

// Optional historical source proof requires original Git objects; it is not a default shallow-checkout harness test.
const plan = JSON.parse(readFileSync(new URL("../harness/private-mobile-minute-boundary-split-plan.json", import.meta.url), "utf8"));
const eslintRequire = createRequire(realpathSync(resolve(repoRoot, "apps/kcoder-studio/renderer/node_modules/eslint/package.json")));
const { parse } = eslintRequire("espree"), { analyze } = eslintRequire("eslint-scope");
const read = path => readFileSync(resolve(repoRoot, path), "utf8");

test("both extracted launchers retain every original gate, pin, declaration and run body", () => {
  const original = readOriginalMinuteBoundarySource();
  assert.equal(plan.original.blob, minuteBoundaryOriginal.blob);
  assert.equal(plan.original.sha256, minuteBoundaryOriginal.sha256);
  const ast = parse(original, { ecmaVersion: "latest", sourceType: "module", range: true });
  const scopes = analyze(ast, { ecmaVersion: 2025, sourceType: "module" });
  const functions = ast.body.filter(node => node.type === "FunctionDeclaration");
  let expected = original;
  for (const group of plan.groups) {
    const first = functions.find(node => node.id.name === group.first);
    const next = functions.find(node => node.id.name === group.next);
    assert.ok(first && next && first.start < next.start);
    const nodes = functions.filter(node => node.start >= first.start && node.start < next.start);
    const names = new Set(nodes.map(node => node.id.name)), parameters = new Set();
    assert.deepEqual([...names], group.names);
    for (const node of nodes) for (const reference of scopes.acquire(node).through) {
      if (!names.has(reference.identifier.name) && reference.resolved?.scope.type === "module") parameters.add(reference.identifier.name);
    }
    assert.deepEqual([...parameters].sort(), group.parameters, "every original closure reference must be passed unchanged");
    const body = original.slice(first.start, next.start);
    const helper = "// Private historical minute-boundary mechanisms; construction starts no resources.\nexport function " + group.factory + "({\n" +
      group.parameters.map(name => "  " + name + ",").join("\n") + "\n}) {\n" + body + "return { " + group.names.join(", ") + " };\n}\n";
    assert.equal(read("apps/kcoder-studio/e2e/harness/" + group.leaf), helper, "moved function bodies and inter-function comments are byte-identical");
    expected = expected.replace(body, "");
  }
  const lastImport = ast.body.filter(node => node.type === "ImportDeclaration").at(-1);
  const importText = original.slice(lastImport.start, lastImport.end);
  const imports = plan.groups.map(group => 'import { ' + group.factory + ' } from "../harness/' + group.leaf + '";').join("\n") +
    '\nimport { observeSeparatedSuiteSourceInputs } from "../harness/separated-suite-source-inputs.mjs";\n';
  expected = expected.replace(importText, importText + "\n" + imports);
  const wiring = plan.groups.map(group => "const { " + group.names.join(", ") + " } = " + group.factory + "({\n" +
    group.parameters.map(name => "  " + name + ",").join("\n") + "\n});\n").join("\n");
  expected = expected.replace("await runE2E(import.meta.url, {", wiring + "\nawait runE2E(import.meta.url, {");
  const guard = "  await observeSeparatedSuiteSourceInputs(context, [\n    import.meta.url,\n" +
    plan.groups.map(group => '    new URL("../harness/' + group.leaf + '", import.meta.url),').join("\n") + "\n  ]);\n";
  expected = expected.replace("}, async context => {\n", "}, async context => {\n" + guard);
  for (const root of plan.roots) assert.equal(read(root), expected, "the original run body changes only to observe its separated source closure");
  assert.equal(plan.groups.reduce((count, group) => count + group.names.length, 0), 51);
});

test("both private launchers reject missing historical authorization flags before creating a run", t => {
  const originalHelper = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/helpers/gateway-runtime-snapshot-guard.mjs");
  if (!existsSync(originalHelper)) {
    t.skip("UNMET_PREREQUISITE: original gateway-runtime-snapshot-guard.mjs is unavailable; actual launcher authorization was not run");
    return;
  }
  for (const source of plan.roots) {
    const runRoot = resolve(repoRoot, "target/test", source), existed = existsSync(runRoot);
    const result = spawnSync(process.execPath, [resolve(repoRoot, source)], { cwd: repoRoot, timeout: 10_000, encoding: "utf8",
      env: { PATH: process.env.PATH || "" } });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /the refresh\/send\/background entry requires --fault-scenarios/);
    if (!existed) assert.equal(existsSync(runRoot), false, "authorization rejection cannot create a run or owned service");
  }
});

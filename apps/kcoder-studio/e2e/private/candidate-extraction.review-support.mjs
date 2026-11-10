import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { repoRoot } from "../harness/run-context.mjs";

// Optional source proofs use the repository's pinned parser, not a new runtime dependency.
const require = createRequire(realpathSync(resolve(repoRoot, "apps/kcoder-studio/renderer/node_modules/eslint/package.json")));
const { parse } = require("espree"), { analyze } = require("eslint-scope");
export const parseSource = source => parse(source, { ecmaVersion: "latest", sourceType: "module", range: true });
export function functionsAndScopes(source) {
  const ast = parseSource(source);
  return { ast, functions: ast.body.filter(node => node.type === "FunctionDeclaration"),
    scopes: analyze(ast, { ecmaVersion: 2025, sourceType: "module" }) };
}
export function moduleReferences(node, scopes) {
  return scopes.acquire(node).through.filter(reference => reference.resolved?.scope.type === "module");
}
export function factorySource(original, group) {
  return "// Private historical candidate mechanisms; construction starts no resources.\nexport function " + group.factory + "({\n" +
    group.parameters.map(name => "  " + name + ",").join("\n") + "\n}) {\n" +
    group.segments.map(({ start, end }) => original.slice(start, end)).join("") +
    "return { " + group.names.join(", ") + " };\n}\n";
}
function specifier(root, path) {
  const name = relative(dirname(root), path).split("\\").join("/");
  return name.startsWith(".") ? name : "./" + name;
}
export function extractedRoot(original, plan) {
  const { ast } = functionsAndScopes(original);
  let output = original;
  const ranges = plan.groups.flatMap(group => group.segments).sort((left, right) => right.start - left.start);
  for (const { start, end } of ranges) output = output.slice(0, start) + output.slice(end);
  const imports = plan.groups.map(group => 'import { ' + group.factory + ' } from "' + specifier(plan.root, group.path) + '";').join("\n") +
    '\nimport { observeSeparatedSuiteSourceInputs } from "' + specifier(plan.root, "apps/kcoder-studio/e2e/harness/separated-suite-source-inputs.mjs") + '";\n';
  const lastImport = ast.body.filter(node => node.type === "ImportDeclaration").at(-1);
  const originalImport = original.slice(lastImport.start, lastImport.end);
  output = output.replace(originalImport, originalImport + "\n" + imports);
  const wiring = plan.groups.map(group => "const { " + group.names.join(", ") + " } = " + group.factory + "({\n" +
    group.parameters.map(name => "  " + name + ",").join("\n") + "\n});\n").join("\n");
  output = output.replace("await runE2E(import.meta.url, {", wiring + "\nawait runE2E(import.meta.url, {");
  const observation = "  await observeSeparatedSuiteSourceInputs(context, [\n    import.meta.url,\n" +
    plan.groups.map(group => '    new URL("' + specifier(plan.root, group.path) + '", import.meta.url),').join("\n") + "\n  ]);\n";
  const run = ast.body.find(node => node.type === "ExpressionStatement" && node.expression.type === "AwaitExpression"
    && node.expression.argument.callee?.name === "runE2E").expression.argument;
  const callback = run.arguments.at(-1);
  const boundary = original.slice(callback.start, callback.body.start + 1) + "\n";
  assert.equal(output.split(boundary).length, 2, "one original launcher boundary is required");
  return output.replace(boundary, boundary + observation);
}
export function verifyExtraction(original, plan) {
  const { ast, functions, scopes } = functionsAndScopes(original);
  const moved = new Set(plan.groups.flatMap(group => group.names));
  const boundary = original.indexOf("await runE2E(import.meta.url, {");
  for (const reference of scopes.scopes.find(scope => scope.type === "module").references) {
    assert.ok(!(moved.has(reference.identifier.name) && reference.identifier.start < boundary),
      "top-level initializers cannot depend on a formerly hoisted moved function");
  }
  const available = new Set(ast.body.filter(node => node.type === "FunctionDeclaration").map(node => node.id.name).filter(name => !moved.has(name)));
  for (const group of plan.groups) {
    const own = new Set(group.names), parameters = new Set();
    assert.equal(own.size, group.names.length);
    assert.equal(group.segments.length, group.names.length);
    for (const [index, name] of group.names.entries()) {
      const node = functions.find(node => node.id.name === name);
      assert.ok(node, "original function must exist");
      const position = ast.body.indexOf(node), end = ast.body[position + 1]?.start ?? original.length;
      assert.deepEqual(group.segments[index], { start: node.start, end }, "the function and following whitespace/comments remain exact");
      assert.ok(!original.slice(node.start, node.end).includes("import.meta"), "module-relative functions stay in the original launcher");
      for (const reference of moduleReferences(node, scopes)) {
        assert.ok(!reference.resolved.defs.some(definition => ["let", "var"].includes(definition.kind)), "mutable module cells remain in their original closure");
        assert.ok(reference.resolved.defs.every(definition => definition.type === "FunctionName"
          || definition.node.start < boundary), "injected constants must already exist at the original run boundary");
        if (!own.has(reference.identifier.name)) parameters.add(reference.identifier.name);
      }
    }
    assert.deepEqual([...parameters].sort(), group.parameters, "the exact original free-variable closure is injected");
    for (const dependency of group.parameters.filter(name => moved.has(name))) assert.ok(available.has(dependency), "factories need original function references, never forward wrappers or TDZ access");
    for (const name of group.names) available.add(name);
    const actual = readFileSync(resolve(repoRoot, group.path), "utf8");
    assert.equal(actual, factorySource(original, group), "all original function bytes and comments remain unchanged");
    assert.ok(actual.split("\n").length <= 3000);
  }
  const root = readFileSync(resolve(repoRoot, plan.root), "utf8");
  assert.equal(root, extractedRoot(original, plan), "only factory wiring and source-closure observation may change the launcher");
  assert.ok(root.split("\n").length <= 3000);
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { readRunnerSources } from "./runner-source.mjs";
import {
  repoRoot,
  toolRoot,
  defaultWorkspaceTemplate,
} from "../lib/runtime-paths.mjs";

const entry = new URL("../bin/tui-lab.mjs", import.meta.url);
const contract = JSON.parse(
  await readFile(
    new URL("./fixtures/cli-contract.json", import.meta.url),
    "utf8",
  ),
);

test("CLI preserves every registered command and its original help contract", async () => {
  const source = await readFile(entry, "utf8");
  const commands = [...source.matchAll(/case ["']([^"']+)["']:/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(commands, contract.commands);
  const help = spawnSync(process.execPath, [fileURLToPath(entry), "--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.equal(help.stdout, contract.help);
});

test("CLI retains failure exit codes for invalid commands and options", () => {
  for (const [args, expected] of [
    [["unknown", "--description", "contract"], /unknown command: unknown/],
    [["--invalid-flag"], /unknown option: --invalid-flag/],
  ]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(entry), ...args],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /Usage:/);
  }
});

test("runtime paths and mounted module limits survive entry-point extraction", async () => {
  assert.equal(
    toolRoot,
    path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  );
  assert.equal(repoRoot, path.resolve(toolRoot, "..", ".."));
  assert.equal(
    defaultWorkspaceTemplate,
    path.join(toolRoot, "workspace-template"),
  );
  const sources = await readRunnerSources(entry);
  for (const [file, source] of sources) {
    const lines = source.trimEnd().split("\n").length;
    assert.ok(lines <= 3000, `${file}: ${lines} lines`);
  }
  assert.ok(sources.get(entry.href).trimEnd().split("\n").length <= 500);
  for (const name of [
    "session.mjs",
    "runtime-artifacts.mjs",
    "browser-scenario.mjs",
    "scenarios/session-resume.mjs",
    "scenarios/targeted-subagent-steer.mjs",
  ]) {
    assert.ok(
      sources.has(new URL(`../lib/${name}`, import.meta.url).href),
      `CLI must mount ${name}`,
    );
  }
});

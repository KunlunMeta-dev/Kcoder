import assert from "node:assert/strict";
import { rename, writeFile, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import { observeSeparatedSuiteSourceInputs } from "./separated-suite-source-inputs.mjs";

async function fixture(t, name) {
  const context = await RunContext.create(import.meta.url, {
    testId: `separated-source-${name}`, modelPolicy: "model-independent owned text fixtures; no browser, application, model or external service",
  });
  t.after(() => context.finish("passed"));
  const path = context.pathInState("source-input.txt");
  await writeFile(path, "AAAA", { flag: "wx", mode: 0o600 });
  return { context, path, url: pathToFileURL(path) };
}

test("separated mechanisms include their verifier and detect same-inode equal-length source edits", async t => {
  const { context, path, url } = await fixture(t, "edited");
  const receipt = await observeSeparatedSuiteSourceInputs(context, [url]);
  assert.equal(receipt.inputs.length, 2);
  assert.ok(receipt.inputs.some(input => input.path.endsWith("separated-suite-source-inputs.mjs")));
  await receipt.verify();
  await writeFile(path, "BBBB");
  await assert.rejects(receipt.verify(), /separated suite source modules changed/);
  await writeFile(path, "AAAA");
  await receipt.verify();
});

test("equal source bytes at a different original file identity do not satisfy postflight", async t => {
  const { context, path, url } = await fixture(t, "replaced");
  const receipt = await observeSeparatedSuiteSourceInputs(context, [url]);
  const saved = context.pathInState("original-input.txt");
  await rename(path, saved);
  await writeFile(path, "AAAA", { flag: "wx", mode: 0o600 });
  await assert.rejects(receipt.verify(), /separated suite source modules changed/);
  await rm(path);
  await rename(saved, path);
  await receipt.verify();
});

test("a source closure cannot read remote URLs, repository-external files or an unbounded roster", async () => {
  const context = { addCleanup() { assert.fail("an invalid closure cannot be admitted"); },
    async writeArtifactJson() { assert.fail("an invalid closure cannot publish a receipt"); } };
  await assert.rejects(observeSeparatedSuiteSourceInputs(context, [new URL("https://fixture.invalid/source")]));
  await assert.rejects(observeSeparatedSuiteSourceInputs(context, [new URL("file:///outside-owned-repository/source")]));
  await assert.rejects(observeSeparatedSuiteSourceInputs(context, []));
  await assert.rejects(observeSeparatedSuiteSourceInputs(context, Array(16).fill(new URL(import.meta.url))));
});


test("an owned parent link cannot make an outside toolchain file into a repository source input", async t => {
  const { context } = await fixture(t, "linked-parent");
  const link = context.pathInState("outside-toolchain-parent");
  await symlink(dirname(process.execPath), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(observeSeparatedSuiteSourceInputs(context, [pathToFileURL(join(link, basename(process.execPath)))]), /escaped physical repository/);
});

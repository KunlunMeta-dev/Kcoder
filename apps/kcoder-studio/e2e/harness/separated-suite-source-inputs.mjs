import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot } from "./run-context.mjs";

async function snapshot(url) {
  assert.ok(url instanceof URL && url.protocol === "file:", "suite source inputs require local file URLs");
  const path = resolve(fileURLToPath(url));
  const name = relative(repoRoot, path);
  assert.ok(name && name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name), "suite source input escaped repository");
  const physical = relative(await realpath(repoRoot), await realpath(path));
  assert.ok(physical && physical !== ".." && !physical.startsWith(`..${sep}`) && !isAbsolute(physical), "suite source input escaped physical repository");
  const before = await lstat(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 4n * 1024n * 1024n, "suite source input must be a bounded regular file");
  const file = await open(path, "r");
  try {
    const selected = await file.stat({ bigint: true });
    assert.equal(selected.dev, before.dev, "suite source input changed during open");
    assert.equal(selected.ino, before.ino, "suite source input changed during open");
    const bytes = await file.readFile();
    const after = await lstat(path, { bigint: true });
    assert.equal(after.dev, before.dev, "suite source input changed during read");
    assert.equal(after.ino, before.ino, "suite source input changed during read");
    assert.equal(BigInt(bytes.length), before.size, "suite source input changed during read");
    assert.equal(after.size, before.size, "suite source input changed during read");
    return { path: name.split(sep).join("/"), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), device: String(selected.dev), inode: String(selected.ino) };
  } finally { await file.close(); }
}

// Moving formerly local mechanisms must keep them inside the original
// launcher's unchanged-source boundary. This is test provenance, not product data.
export async function observeSeparatedSuiteSourceInputs(context, urls) {
  assert.ok(Array.isArray(urls) && urls.length > 0 && urls.length <= 15, "suite source input limit exceeded");
  const inputs = [...urls, import.meta.url].map(value => value instanceof URL ? value : new URL(value));
  const unique = [...new Map(inputs.map(url => [url.href, url])).values()];
  const expected = await Promise.all(unique.map(snapshot));
  const verify = async () => {
    const current = await Promise.all(unique.map(snapshot));
    assert.deepEqual(current, expected, "separated suite source modules changed during the run");
  };
  context.addCleanup("verify separated suite source modules", verify);
  await context.writeArtifactJson("separated-suite-source-inputs.json", {
    schemaVersion: 1, classification: "test mechanism source closure; original launcher digest stays independent", inputs: expected,
  });
  return { inputs: expected, verify };
}

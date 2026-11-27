import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import { stageManagedBrowserRuntime } from "./managed-browser.mjs";

test(
  "managed runtime staging owns only its CLI copy and browser resource link",
  {
    skip: process.platform !== "linux",
  },
  async (t) => {
    const source = await mkdtemp(
      join(tmpdir(), "kcoder-managed-browser-source-"),
    );
    t.after(() => rm(source, { recursive: true, force: true }));
    const chromeDirectory = join(source, "chrome-linux64");
    await mkdir(chromeDirectory);
    const browser = join(chromeDirectory, "chrome");
    const cli = join(source, "kcoder");
    await writeFile(browser, "browser-fixture", { mode: 0o700 });
    await writeFile(cli, "cli-fixture", { mode: 0o700 });
    await chmod(browser, 0o700);
    const context = await RunContext.create(import.meta.url, {
      testId: "managed-browser-staging-cleanup",
      modelPolicy: "model-independent filesystem ownership check",
    });
    let failure;
    try {
      const staged = await stageManagedBrowserRuntime(context, cli, browser);
      assert.equal(await readFile(staged.kcoderBin, "utf8"), "cli-fixture");
      await access(staged.kcoderBin, constants.X_OK);
      assert.equal(
        (await lstat(staged.chromeDirectory)).isSymbolicLink(),
        true,
      );
      assert.equal(await readlink(staged.chromeDirectory), chromeDirectory);
      assert.ok(staged.kcoderBin.startsWith(context.stateDir));
      assert.ok(staged.chromeDirectory.startsWith(context.stateDir));
    } catch (error) {
      failure = error;
    }
    await context.finish(failure ? "failed" : "passed", {}, failure);
    assert.equal(await readFile(browser, "utf8"), "browser-fixture");
    assert.equal(await readFile(cli, "utf8"), "cli-fixture");
    await assert.rejects(access(context.stateDir));
  },
);

test("managed staging rejects a system browser path instead of silently overriding discovery", async () => {
  const context = {
    pathInState: () => {
      throw new Error("must validate layout before staging");
    },
  };
  await assert.rejects(
    stageManagedBrowserRuntime(
      context,
      "/tmp/kcoder",
      "/usr/bin/google-chrome",
    ),
    /chrome-linux64/,
  );
});

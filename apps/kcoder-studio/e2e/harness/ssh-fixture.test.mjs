import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";
import { sshFixtureUser } from "./ssh-fixture.mjs";

test("SSH fixture resolves its actual account when the isolated environment omits USER", () => {
  assert.equal(sshFixtureUser("explicit-user", "environment-user"), "explicit-user");
  assert.equal(sshFixtureUser(undefined, "environment-user"), "environment-user");
  assert.equal(sshFixtureUser(undefined, ""), userInfo().username);
});

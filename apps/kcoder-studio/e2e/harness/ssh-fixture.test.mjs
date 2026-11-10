import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";
import { sshFixtureUser, sshFixtureListenHost } from "./ssh-fixture.mjs";

test("SSH fixture resolves its actual account when the isolated environment omits USER", () => {
  assert.equal(sshFixtureUser("explicit-user", "environment-user"), "explicit-user");
  assert.equal(sshFixtureUser(undefined, "environment-user"), "environment-user");
  assert.equal(sshFixtureUser(undefined, ""), userInfo().username);
});

test('SSH fixture remains loopback by default and accepts only one actual explicit host address', () => {
  const interfaces = { owned: [{ address: '192.0.2.20' }] };
  assert.equal(sshFixtureListenHost(undefined, interfaces), '127.0.0.1');
  assert.equal(sshFixtureListenHost('192.0.2.20', interfaces), '192.0.2.20');
  for (const host of ['0.0.0.0', '::', '192.0.2.21', 'owned.example', '192.0.2.20\n'])
    assert.throws(() => sshFixtureListenHost(host, interfaces));
});

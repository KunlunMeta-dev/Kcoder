import assert from "node:assert/strict";
import test from "node:test";
import { staticTreeContentSha } from "./public-static-tree-projection.mjs";

function treeFixture() {
  return {
    root: { path: "mobile-web-root", mode: 0o700, uid: 1001, gid: 1001, dev: 44, inode: 17, size: 96, mtimeNs: "101", ctimeNs: "102" },
    directories: [
      { path: "assets", mode: 0o700, uid: 1001, gid: 1001, dev: 44, inode: 18, size: 64, mtimeNs: "201", ctimeNs: "202" },
    ],
    files: [
      { path: "assets/index.js", size: 17, sha256: "a".repeat(64), mode: 0o600, uid: 1001, gid: 1001, dev: 44, inode: 19, mtimeNs: "301", ctimeNs: "302" },
      { path: "index.html", size: 23, sha256: "b".repeat(64), mode: 0o600, uid: 1001, gid: 1001, dev: 44, inode: 20, mtimeNs: "401", ctimeNs: "402" },
    ],
  };
}

test("static tree content ignores rename-sensitive and nanosecond diagnostic metadata", () => {
  const original = treeFixture();
  const restored = structuredClone(original);
  restored.root = { ...restored.root, path: "renamed-stage-root", dev: 45, inode: 117, size: 112, mtimeNs: "90071992547409931", ctimeNs: "90071992547409937" };
  restored.directories[0] = { ...restored.directories[0], dev: 45, inode: 118, size: 80, mtimeNs: "90071992547409941", ctimeNs: "90071992547409947" };
  restored.files = restored.files.map((file, index) => ({
    ...file,
    dev: 45,
    inode: 119 + index,
    mtimeNs: `900719925474099${51 + index}`,
    ctimeNs: `900719925474099${57 + index}`,
  }));

  assert.equal(staticTreeContentSha(restored), staticTreeContentSha(original));
});

test("static tree content still binds relative paths, bytes, ownership, and modes", () => {
  const original = treeFixture();
  const mutations = [
    tree => { tree.files[0].path = "assets/renamed.js"; },
    tree => { tree.files[0].size += 1; },
    tree => { tree.files[0].sha256 = "c".repeat(64); },
    tree => { tree.files[0].mode = 0o644; },
    tree => { tree.files[0].uid += 1; },
    tree => { tree.directories[0].gid += 1; },
    tree => { tree.directories.push({ path: "extra", mode: 0o700, uid: 1001, gid: 1001 }); },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(staticTreeContentSha(changed), staticTreeContentSha(original));
  }
});

test("static tree projection rejects missing manifest structure", () => {
  assert.throws(() => staticTreeContentSha(null), /incomplete/);
  assert.throws(() => staticTreeContentSha({ root: {}, directories: [] }), /incomplete/);
});

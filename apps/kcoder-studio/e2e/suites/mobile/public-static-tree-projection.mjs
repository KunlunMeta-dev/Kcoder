import { createHash } from "node:crypto";

function pathMetadata(row) {
  return {
    path: row.path,
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
  };
}

function rootMetadata(row) {
  return {
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
  };
}

export function staticTreeContentProjection(tree) {
  if (!tree || !tree.root || !Array.isArray(tree.directories) || !Array.isArray(tree.files)) {
    throw new TypeError("static tree manifest is incomplete");
  }
  const files = tree.files.map(file => ({
    ...pathMetadata(file),
    size: file.size,
    sha256: file.sha256,
  })).sort((left, right) => left.path.localeCompare(right.path));
  return {
    root: rootMetadata(tree.root),
    directories: tree.directories.map(pathMetadata)
      .sort((left, right) => left.path.localeCompare(right.path)),
    files,
  };
}

export function staticTreeContentSha(tree) {
  return createHash("sha256")
    .update(JSON.stringify(staticTreeContentProjection(tree)))
    .digest("hex");
}

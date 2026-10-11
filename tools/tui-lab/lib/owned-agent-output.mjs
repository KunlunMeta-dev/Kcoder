import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function assertOwned(owner, candidate, allowOwner = false) {
  const relative = path.relative(owner, candidate);
  if ((!relative && !allowOwner) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Sub-agent output escapes its owned artifact directory');
  }
}

// A task may publish its intended output path before the artifact is written.
// Return no readable path until realpath can validate the final artifact. The
// caller retains its existing bounded poll deadline and never reads pending paths.
export async function resolveOwnedAgentOutput(agentDir, declared, resolve = realpath, inspect = lstat) {
  const owner = await resolve(agentDir);
  try {
    const output = await resolve(declared);
    assertOwned(owner, output);
    return declared;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Missing paths still must be lexically owned. Inspect the closest existing
  // ancestor so a symlink escaping the owner cannot masquerade as pending.
  assertOwned(path.resolve(agentDir), path.resolve(declared));
  let ancestor = path.resolve(declared);
  for (;;) {
    try {
      await inspect(ancestor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    // Keep this outside the ENOENT catch: dangling symlinks are not proven owned.
    assertOwned(owner, await resolve(ancestor), true);
    return null;
  }
}

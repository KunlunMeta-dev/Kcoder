import { realpath } from 'node:fs/promises';
import { win32 } from 'node:path';

const same = (left, right) => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
const below = (root, child) => {
  const relative = win32.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
};

/** Resolve only the profile selected for this owned Windows test account. */
export async function resolveOwnedInstalledProfile({ requested, fixtureRoot, fixtureUsername, readIdentity, readSelection, canonicalize = realpath }) {
  if (!/^kc_e2e_[a-f0-9]{8}$/.test(fixtureUsername)) throw new Error('Invalid owned fixture username');
  const identity = await readIdentity();
  if (!identity?.sid || !win32.isAbsolute(identity.userProfile)
      || !win32.basename(identity.userProfile).toLowerCase().startsWith(fixtureUsername))
    throw new Error('Current Windows profile does not belong to the owned account');
  if (!below(fixtureRoot, requested)) throw new Error('Requested profile escaped the owned fixture');
  const selection = await readSelection({ identity });
  const recovered = Boolean(selection && same(selection.sourceDirectory, requested));
  if (recovered && selection.sid !== identity.sid) throw new Error('Recovered profile SID mismatch');
  const candidate = recovered ? selection.directory : requested;
  if (!win32.isAbsolute(candidate)) throw new Error('Selected profile is not absolute');
  const [actual, fixture, user] = await Promise.all([canonicalize(candidate), canonicalize(fixtureRoot), canonicalize(identity.userProfile)]);
  if (!below(fixture, actual) && !below(user, actual)) throw new Error('Selected profile escaped the owned account');
  return { directory: actual, sourceDirectory: requested, sid: identity.sid, recovered };
}

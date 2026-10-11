// Exact symlink layout observed in the pinned official Chrome for Testing mac-x64 archive.
export function isMacChromeFrameworkLink(path, target, release) {
  if (release.platform !== 'mac-x64') return false;
  const prefix = `${release.directory}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/`;
  if (!path.startsWith(prefix)) return false;
  const member = path.slice(prefix.length);
  if (member === 'Versions/Current') return target === release.version;
  return ['Resources', 'Libraries', 'Helpers', 'Google Chrome for Testing Framework'].includes(member)
    && target === `Versions/Current/${member}`;
}

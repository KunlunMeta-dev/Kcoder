// Keep the Rust, Electron and bundled-resource architectures in agreement.
export function macTarget(arch = process.arch) {
  const targets = {
    x64: { target: 'x86_64-apple-darwin', platform: 'mac-x64', cpuType: 0x01000007, architecture: 'x86_64', stage: 'macos-input' },
    arm64: { target: 'aarch64-apple-darwin', platform: 'mac-arm64', cpuType: 0x0100000c, architecture: 'arm64', stage: 'macos-arm64-input' },
  };
  if (!Object.hasOwn(targets, arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  return { arch, ...targets[arch] };
}

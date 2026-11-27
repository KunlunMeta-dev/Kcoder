import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

// The deployment-owned default binary is the trust anchor, not a per-target
// command or its advertised capabilities. Keep its inode pinned through exec.
export function captureTrustedLocalAppServer(command, platform = process.platform, temporaryRoot = tmpdir()) {
  let fd, imageDirectory, pinned;
  try {
    if (!['linux', 'darwin'].includes(platform) || !isAbsolute(command)) return null;
    const source = realpathSync(command);
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(fd, { bigint: true });
    const magic = Buffer.alloc(4);
    const nativeMagic = () => platform === 'linux' ? magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      : [0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE());
    if (!identity.isFile() || (identity.mode & 0o111n) === 0n ||
        readSync(fd, magic, 0, 4, 0) !== 4 || !nativeMagic()) {
      closeSync(fd); return null;
    }
    let closed = false;
    // A peer adding/removing an inode pin changes ctime but never executable bytes.
    const keys = platform === 'darwin' ? ['dev', 'ino', 'size', 'mtimeNs'] : ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
    const same = info => info.isFile() && keys
      .every(key => info[key] === identity[key]);
    if (platform === 'darwin') {
      // Darwin refuses exec of /dev/fd. An exclusive hard link pins the
      // same deployment inode without copying bytes or trusting a replacement path.
      // The configured Home and deployment image must share a filesystem.
      const imageParent = realpathSync(temporaryRoot);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = join(imageParent, `kcoder-native-image-${randomUUID()}`);
        try { mkdirSync(candidate); imageDirectory = candidate; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!imageDirectory) throw new Error('Could not allocate a temporary deployment image directory');
      pinned = join(imageDirectory, 'kcoder');
      linkSync(source, pinned);
      if (!same(fstatSync(fd, { bigint: true })) || !same(statSync(pinned, { bigint: true }))) throw new Error('Trusted image changed');
    }
    return {
      matches(target) {
        if (closed || target.runtime !== 'kcoder' || target.transport !== 'local' || target.security || !isAbsolute(target.command)) return false;
        try { return same(fstatSync(fd, { bigint: true })) && same(statSync(realpathSync(target.command), { bigint: true }))
          && (!pinned || same(statSync(pinned, { bigint: true }))); }
        catch { return false; }
      },
      launch(target, spec) {
        if (!this.matches(target)) throw new Error('Trusted local app-server identity changed');
        // fd 3 is inherited solely for exec; a pathname replacement cannot swap
        // a configured custom executable into this internal lifecycle lane.
        return { ...spec, command: pinned ?? '/proc/self/fd/3', stdio: ['pipe', 'pipe', 'pipe', fd] };
      },
      close() { if (!closed) { closed = true; closeSync(fd); if (imageDirectory) rmSync(imageDirectory, { recursive: true, force: true }); } },
    };
  } catch {
    if (fd !== undefined) closeSync(fd);
    if (imageDirectory) rmSync(imageDirectory, { recursive: true, force: true });
    return null;
  }
}

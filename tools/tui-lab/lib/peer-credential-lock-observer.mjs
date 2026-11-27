import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Read only the kernel lock record for this run's one credential lock inode.
 * No process arguments, environments, credential bytes or unrelated lock
 * records are retained. This diagnostic never acquires or releases the lock.
 */
export function observePeerCredentialLock(profile) {
  const events = [];
  const began = performance.now();
  let active = true, checking = false, previous = null;
  const poll = async () => {
    if (!active || checking) return;
    checking = true;
    try {
      const info = await stat(path.join(profile, 'peer-gateway-credentials.lock'), { bigint: true });
      const text = await readFile('/proc/locks', 'utf8');
      if (text.length > 1024 * 1024) return;
      const holders = [];
      for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const index = parts.findIndex(value => /^[0-9a-f]+:[0-9a-f]+:[0-9]+$/i.test(value));
        if (index < 1) continue;
        const [major, minor, inode] = parts[index].split(':');
        const expectedMajor = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & ~0xfffn);
        const expectedMinor = (info.dev & 0xffn) | ((info.dev >> 12n) & ~0xffn);
        if (BigInt(inode) !== info.ino || BigInt('0x' + major) !== expectedMajor || BigInt('0x' + minor) !== expectedMinor) continue;
        const pid = Number(parts[index - 1]);
        if (Number.isSafeInteger(pid)) holders.push({ pid, kind: parts[1], mode: parts[index - 2] });
      }
      const key = JSON.stringify(holders);
      if (key !== previous && events.length < 256) { previous = key; events.push({ elapsedMs: performance.now() - began, holders }); }
    } catch { /* Missing owned leaf or unavailable procfs is diagnostic only. */ }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void poll(); }, 10); timer.unref?.(); void poll();
  return { stop: async () => { active = false; clearInterval(timer); while (checking) await new Promise(resolve => setTimeout(resolve, 1)); return [...events]; } };
}

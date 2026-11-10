import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function sourceAppServerBinary(repoRoot, env = process.env, platform = process.platform) {
  const executable = platform === 'win32' ? 'kcoder.exe' : 'kcoder';
  const override = env.KCODER_TARGET_DIR || env.CARGO_TARGET_DIR;
  if (override) return resolve(repoRoot, override, 'debug', executable);
  const cached = resolve(repoRoot, 'target/cache/cargo/main/debug', executable);
  return existsSync(cached) ? cached : resolve(repoRoot, 'target/debug', executable);
}

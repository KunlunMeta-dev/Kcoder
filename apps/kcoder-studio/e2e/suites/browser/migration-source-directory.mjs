import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seedAdoptionSourceFixture } from './migration-source-adoption.mjs';

/** Default environment paths deliberately stay missing; explicit source grants are necessary. */
export async function seedSourceDirectoryAdoption(context, source) {
  const fixture = await seedAdoptionSourceFixture(source);
  const root = context.pathInState('nondefault-source-products');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const claude = resolve(root, 'claude-product'), codex = resolve(root, 'codex-product');
  await rename(source.claude, claude); await rename(source.codex, codex);
  return { fixture: { ...fixture, file: claude + fixture.file.slice(source.claude.length),
    skillDir: claude + fixture.skillDir.slice(source.claude.length),
    history: { ...fixture.history, file: codex + fixture.history.file.slice(source.codex.length) } }, directories: { claude, codex } };
}

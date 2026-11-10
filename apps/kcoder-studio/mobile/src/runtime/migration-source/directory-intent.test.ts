import { expect, it } from 'vitest';
import { createSourceDirectoryIntent, validSourceDirectory } from './directory-intent';
it('accepts source OS absolute path spellings without treating browser paths or relative values as authorization', () => {
  for (const value of ['/owned/claude', 'D:\\Owned\\Codex', '\\\\server\\share\\product']) expect(validSourceDirectory(value)).toBe(true);
  for (const value of ['', '../source', 'source/settings.json', ' C:\\source', '/owned/\nsource', '/'+ '中'.repeat(1500)]) expect(validSourceDirectory(value)).toBe(false);
  expect(() => createSourceDirectoryIntent('codex', '../source')).toThrow('source_transfer_directory_invalid');
});
it('a directory grant remains bound to its product and exact input string', () => {
  const intent = createSourceDirectoryIntent('claude-code', '/owned/source');
  expect(intent.matches('claude-code', '/owned/source')).toBe(true);
  expect(intent.matches('codex', '/owned/source')).toBe(false); expect(intent.matches('claude-code')).toBe(false); expect(intent.matches('claude-code', '/owned/source/')).toBe(false);
});

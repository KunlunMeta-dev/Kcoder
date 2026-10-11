import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMacSystemLibraries } from './mac-executable.mjs';

test('native PDF runtime permits system libraries and refuses an unbundled development toolchain path', () => {
  assert.deepEqual(validateMacSystemLibraries('/owned/pdftotext:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n'), ['/usr/lib/libc++.1.dylib', '/usr/lib/libSystem.B.dylib']);
  for (const dependency of ['/usr/local/lib/libjpeg.dylib', '@rpath/libexample.dylib', '/Users/Admin/private/libfoo.dylib']) {
    assert.throws(() => validateMacSystemLibraries(`/owned/pdftotext:\n\t${dependency} (compatibility version 1.0.0)\n`), /unbundled non-system/);
  }
});

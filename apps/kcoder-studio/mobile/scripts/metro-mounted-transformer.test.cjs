const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { test } = require('node:test');

test('mounted Expo development rewrites actual SDK modules with relative and absolute filenames', () => {
  const previousBase = process.env.KCODER_STUDIO_MOBILE_DEV_BASE;
  process.env.KCODER_STUDIO_MOBILE_DEV_BASE = '/g/owned/mobile';
  const original = require('@expo/metro-config/babel-transformer');
  const expoRoot = dirname(require.resolve('expo/package.json'));
  const transform = original.transform;
  original.transform = args => args;
  try {
    const mounted = require('./metro-mounted-transformer.cjs');
    for (const { relative, absolute, needle } of [
      {
        relative: 'expo/build/async-require/hmr.js',
        absolute: resolve(expoRoot, 'build/async-require/hmr.js'),
        needle: 'new MetroHMRClient(`${origin}/g/owned/mobile/hot`)',
      },
      {
        relative: 'expo/build/async-require/messageSocket.js',
        absolute: resolve(expoRoot, 'build/async-require/messageSocket.js'),
        needle: 'window.location.host}/g/owned/mobile/message',
      },
      {
        relative: 'expo-router/build/fork/getStateFromPath-forks.js',
        absolute: require.resolve('expo-router/build/fork/getStateFromPath-forks.js'),
        needle: "'development' || baseUrl",
      },
      {
        relative: 'expo-router/build/fork/getPathFromState-forks.js',
        absolute: require.resolve('expo-router/build/fork/getPathFromState-forks.js'),
        needle: "'development' || baseUrl",
      },
    ]) {
      const src = readFileSync(absolute, 'utf8');
      for (const filename of [absolute, `node_modules/${relative}`]) {
        const result = mounted.transform({ filename, src, options: { dev: true, platform: 'web' } });
        assert.ok(result.src.includes(needle), filename);
      }
      assert.equal(mounted.transform({ filename: absolute, src, options: { dev: false, platform: 'web' } }).src, src);
    }
  } finally {
    original.transform = transform;
    if (previousBase === undefined) delete process.env.KCODER_STUDIO_MOBILE_DEV_BASE;
    else process.env.KCODER_STUDIO_MOBILE_DEV_BASE = previousBase;
  }
});

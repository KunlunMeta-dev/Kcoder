// Expo Router skips its base URL in development, and Expo's web HMR uses root sockets.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const original = require('@expo/metro-config/babel-transformer');
const base = process.env.KCODER_STUDIO_MOBILE_DEV_BASE;
const routerFiles = /\/node_modules\/expo-router\/build\/fork\/(?:getPathFromState(?:-forks)?|getStateFromPath-forks)\.js$/;

function replaceOnce(source, needle, replacement, filename) {
  const index = source.indexOf(needle);
  if (index === -1 || source.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(`Expo mounted preview compatibility changed in ${filename}`);
  }
  return source.replace(needle, replacement);
}

exports.transform = function transform(args) {
  if (!args.options.dev || args.options.platform !== 'web') return original.transform(args);
  const file = '/' + args.filename.replaceAll('\\', '/').replace(/^\/+/, '');
  let { src } = args;
  if (routerFiles.test(file)) {
    const name = file.includes('getStateFromPath') ? 'stripBaseUrl' : 'appendBaseUrl';
    const signature = `function ${name}(path, baseUrl = process.env.EXPO_BASE_URL) {\n    if (process.env.NODE_ENV !== 'development') {`;
    src = replaceOnce(src, signature, signature.replace("'development')", "'development' || baseUrl)"), file);
  } else if (file.endsWith('/node_modules/expo/build/async-require/hmr.js')) {
    src = replaceOnce(src, 'new MetroHMRClient(`${origin}/hot`)', `new MetroHMRClient(\`\${origin}${base}/hot\`)`, file);
  } else if (file.endsWith('/node_modules/expo/build/async-require/messageSocket.js')) {
    src = replaceOnce(src, 'window.location.host}/message', `window.location.host}${base}/message`, file);
  }
  return original.transform({ ...args, src });
};

exports.getCacheKey = () => createHash('sha256')
  .update(readFileSync(__filename)).update(base).update(original.getCacheKey?.() || '').digest('hex');

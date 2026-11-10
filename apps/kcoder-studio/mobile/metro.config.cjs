const { getDefaultConfig } = require('expo/metro-config');
const { resolve } = require('node:path');

const config = getDefaultConfig(__dirname);
// The shared runtime contract lives outside the Expo app's project root.
config.watchFolders = [...config.watchFolders, resolve(__dirname, '../shared')];
config.resolver.nodeModulesPaths = [...config.resolver.nodeModulesPaths, resolve(__dirname, 'node_modules')];
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, 'txt'])];
const devBase = process.env.KCODER_STUDIO_MOBILE_DEV_BASE;
if (devBase) {
  if (!/^(?:\/g\/[A-Za-z0-9_-]{1,64})?\/mobile$/.test(devBase)) throw new Error('Invalid Mobile Web development base');
  const rewrite = config.server.rewriteRequestUrl;
  config.server.rewriteRequestUrl = input => {
    const url = new URL(input, 'http://127.0.0.1');
    // The web HMR client registers the browser-visible bundle URL with Metro.
    if (!url.pathname.startsWith(`${devBase}/`)) return rewrite(input);
    url.pathname = url.pathname.slice(devBase.length);
    return rewrite(url.href);
  };
  config.transformer.babelTransformerPath = require.resolve('./scripts/metro-mounted-transformer.cjs');
  config.transformer.assetPlugins = [...(config.transformer.assetPlugins || []), require.resolve('./scripts/metro-mounted-assets.cjs')];
}
module.exports = config;

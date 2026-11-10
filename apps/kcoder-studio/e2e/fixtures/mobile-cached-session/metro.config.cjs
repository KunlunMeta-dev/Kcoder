const { createRequire } = require("node:module");
const path = require("node:path");
const mobile = path.resolve(__dirname, "../../../mobile");
const requireMobile = createRequire(path.join(mobile, "package.json"));
const { getDefaultConfig } = requireMobile("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.watchFolders = [mobile, path.resolve(mobile, "../shared")];
config.resolver.nodeModulesPaths = [path.join(mobile, "node_modules")];
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, "txt"])];
const prefix = process.env.KCODER_CACHE_FIXTURE_PREFIX || "/fixtures/mobile-cache";
const originalRewrite = config.server?.rewriteRequestUrl;
config.server = { ...config.server, rewriteRequestUrl(requestUrl) {
  const rewritten = originalRewrite ? originalRewrite(requestUrl) : requestUrl;
  const url = new URL(rewritten, "http://127.0.0.1");
  if (url.pathname.startsWith(`${prefix}/`)) url.pathname = url.pathname.slice(prefix.length);
  return url.toString();
} };
config.resolver.resolveRequest = (context, moduleName, platform) => context.resolveRequest(
  context,
  moduleName.startsWith("@/") ? path.join(mobile, "src", moduleName.slice(2)) : moduleName,
  platform,
);
module.exports = config;

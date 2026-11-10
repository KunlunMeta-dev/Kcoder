const { createRequire } = require("node:module");
const path = require("node:path");
const mobile = path.resolve(__dirname, "../../../mobile");
const requireMobile = createRequire(path.join(mobile, "package.json"));
const { getDefaultConfig } = requireMobile("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.watchFolders = [mobile, path.resolve(mobile, "../shared")];
config.resolver.nodeModulesPaths = [path.join(mobile, "node_modules")];
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, "txt"])];
config.resolver.resolveRequest = (context, moduleName, platform) => context.resolveRequest(context,
  moduleName === "@react-native-async-storage/async-storage" ? path.join(__dirname, "memory-storage.ts")
    : moduleName.startsWith("@/") ? path.join(mobile, "src", moduleName.slice(2)) : moduleName, platform);
module.exports = config;

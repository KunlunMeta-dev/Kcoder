const { getDefaultConfig } = require('expo/metro-config');
const { resolve } = require('node:path');

const config = getDefaultConfig(__dirname);
// The shared runtime contract lives outside the Expo app's project root.
config.watchFolders = [...config.watchFolders, resolve(__dirname, '../shared')];
module.exports = config;

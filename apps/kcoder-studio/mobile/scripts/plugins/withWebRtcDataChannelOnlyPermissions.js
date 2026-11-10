const { withInfoPlist } = require("expo/config-plugins");

function withWebRtcDataChannelOnlyPermissions(config) {
  return withInfoPlist(config, (config) => {
    delete config.modResults.NSMicrophoneUsageDescription;
    return config;
  });
}

module.exports = withWebRtcDataChannelOnlyPermissions;

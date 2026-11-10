// Metro's development asset URLs are root-relative by default.
module.exports = asset => {
  if (typeof asset.httpServerLocation !== 'string' || !asset.httpServerLocation.startsWith('/assets/')) return asset;
  return { ...asset, httpServerLocation: process.env.KCODER_STUDIO_MOBILE_DEV_BASE + asset.httpServerLocation };
};

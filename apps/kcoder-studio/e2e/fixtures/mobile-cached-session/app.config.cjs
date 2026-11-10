module.exports = {
  name: "KCoder cached conversation",
  slug: "kcoder-cached-session-fixture",
  platforms: ["web"],
  web: { bundler: "metro" },
  experiments: { baseUrl: process.env.KCODER_CACHE_FIXTURE_PREFIX || "/fixtures/mobile-cache" },
};

module.exports = {
  name: "KCoder V3 send recovery fixture",
  slug: "kcoder-send-recovery-fixture",
  platforms: ["web"],
  web: { bundler: "metro", output: "single" },
  experiments: { baseUrl: "/fixtures/mobile-send-recovery-v3" },
};

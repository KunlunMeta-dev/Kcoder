import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const entryRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryRoot, "../../../../../../..");
const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
const inputRoot = resolve(repoRoot, "target/private-phone-ux-implementation/b4-reserve-proof-20261009/candidate-static06/test-inputs/mobile-src");
const support = resolve(repoRoot, "apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/support");
const shared = resolve(repoRoot, "apps/kcoder-studio/shared");
const { defineConfig } = await import(pathToFileURL(resolve(mobileRoot, "node_modules/vitest/dist/config.js")).href);
export default defineConfig({
 root: repoRoot,
 cacheDir: resolve(repoRoot, "target/private-phone-ux-implementation/b4-reserve-proof-20261009/candidate-static06/mobile-test-01/vitest-cache"),
 resolve: { alias: [
  { find: /^@\/(protocol\/(attachment-retention|sha256-stream)|storage\/(staged-attachment-[^/]+|retained-attachment-upload)|gateway\/rpc)$/, replacement: `${inputRoot}/$1` },
  { find: /^@\//, replacement: `${mobileRoot}/src/` },
  { find: "vitest", replacement: resolve(mobileRoot, "node_modules/vitest/dist/index.js") },
  { find: "./workspace-profile-fence", replacement: resolve(support, "profile-fence.ts") },
  { find: "./http", replacement: resolve(support, "gateway-http.ts") },
  { find: "../../../shared/gatewayConnectionBudget", replacement: resolve(shared, "gatewayConnectionBudget.ts") },
  { find: "../../../shared/gatewayRequestDeadline.js", replacement: resolve(shared, "gatewayRequestDeadline.js") },
  { find: "react-native", replacement: resolve(support, "react-native.ts") },
 ] },
 test: { environment: "node", include: ["apps/kcoder-studio/e2e/private/candidates/b4-reserve-proof-20261009/static06/consumer-batch.review.test.ts"], pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 20000, hookTimeout: 20000 },
});

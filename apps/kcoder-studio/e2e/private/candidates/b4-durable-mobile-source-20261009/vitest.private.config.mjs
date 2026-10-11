import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const candidateDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(candidateDir, "../../../../../..");
const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
const candidateRoot = resolve(repoRoot, "target/private-phone-ux-implementation/b4-durable-mobile-source-20261009/candidate-static02");
const sourceRoot = resolve(candidateRoot, "source/apps/kcoder-studio/mobile/src");
const supportRoot = resolve(candidateDir, "support");
const sharedRoot = resolve(repoRoot, "apps/kcoder-studio/shared");
const vitestConfigModule = pathToFileURL(resolve(mobileRoot, "node_modules/vitest/dist/config.js")).href;
const vitestRuntimeModule = resolve(mobileRoot, "node_modules/vitest/dist/index.js");
const { defineConfig } = await import(vitestConfigModule);

export default defineConfig({
  root: repoRoot,
  cacheDir: resolve(candidateRoot, "tests/.vitest-private-cache"),
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${sourceRoot}/` },
      { find: "vitest", replacement: vitestRuntimeModule },
      { find: "./workspace-profile-fence", replacement: resolve(supportRoot, "profile-fence.ts") },
      { find: "./http", replacement: resolve(supportRoot, "gateway-http.ts") },
      { find: "../../../shared/gatewayConnectionBudget", replacement: resolve(sharedRoot, "gatewayConnectionBudget.ts") },
      { find: "../../../shared/gatewayRequestDeadline.js", replacement: resolve(sharedRoot, "gatewayRequestDeadline.js") },
      { find: "react-native", replacement: resolve(supportRoot, "react-native.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/*.review.test.ts"],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 20_000,
    reporters: ["default"],
  },
});

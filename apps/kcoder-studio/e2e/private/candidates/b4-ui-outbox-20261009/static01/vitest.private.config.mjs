import { defineConfig } from "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/b4-ui-outbox-20261009/candidate-static01/mobile-overlay/apps/kcoder-studio/mobile/node_modules/vitest/dist/config.js";
export default defineConfig({
 root: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008",
 cacheDir: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/b4-ui-outbox-20261009/candidate-static01/run-06/vitest-cache",
 resolve: { alias: [
  { find: "expo-file-system/legacy", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-file-system/legacy.ts" },
  { find: "expo-document-picker", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-document-picker/build/index.js" },
  { find: "expo-image-picker", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-image-picker/build/ImagePicker.js" },
  { find: "expo-image-manipulator", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-image-manipulator/src/index.ts" },
  { find: "expo-file-system", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-file-system/src/index.ts" },
  { find: "expo-sharing", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/expo-sharing/build/Sharing.js" },
  { find: "react-native-safe-area-context", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/react-native-safe-area-context/lib/commonjs/index.js" },
  { find: "lucide-react-native", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js" },
  { find: /^@\//, replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/b4-ui-outbox-20261009/candidate-static01/mobile-overlay/apps/kcoder-studio/mobile/src/" },
  { find: "react-native", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/support/react-native.ts" },
  { find: "vitest", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/b4-ui-outbox-20261009/candidate-static01/mobile-overlay/apps/kcoder-studio/mobile/node_modules/vitest/dist/index.js" },
  { find: "react", replacement: "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/b4-ui-outbox-20261009/candidate-static01/mobile-overlay/apps/kcoder-studio/mobile/node_modules/react" },
 ] },
 test: { environment: "node", include: ["apps/kcoder-studio/e2e/private/candidates/b4-ui-outbox-20261009/static01/outbox-ui.review.test.tsx"], pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 15000, hookTimeout: 15000 },
});

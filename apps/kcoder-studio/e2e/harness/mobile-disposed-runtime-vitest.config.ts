import { fileURLToPath } from "node:url";

const mobileRoot = fileURLToPath(new URL("../../mobile/", import.meta.url));

export default {
  root: mobileRoot,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../mobile/src/", import.meta.url)),
      react: fileURLToPath(new URL("../../mobile/node_modules/react/index.js", import.meta.url)),
      "react-native": "react-native-web",
    },
  },
  test: {
    environment: "node",
    include: ["../e2e/harness/mobile-disposed-runtime-submit.test.ts"],
  },
};

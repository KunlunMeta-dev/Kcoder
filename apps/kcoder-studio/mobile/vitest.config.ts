import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";

export default defineConfig({
  plugins: [{
    name: "markdown-native-jsx",
    enforce: "pre",
    transform(code, id) {
      if (/node_modules\/(react-native-markdown-display|react-native-fit-image)\/.*\.js$/.test(id)) {
        return transformWithEsbuild(code, id, { loader: "jsx", jsx: "automatic" });
      }
    },
  }],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "react-native": "react-native-web",
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});

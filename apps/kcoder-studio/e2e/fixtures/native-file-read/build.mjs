import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = dirname(fileURLToPath(import.meta.url));
const renderer = resolve(fixture, "../../../renderer");
const require = createRequire(resolve(renderer, "package.json"));
const { build } = await import(require.resolve("vite"));
const { default: react } = await import(
  require.resolve("@vitejs/plugin-react")
);
const output = resolve(process.argv[2]);
if (!output.includes("/target/test/") || !output.includes("/state/"))
  throw new Error("Owned fixture output required");
await build({
  configFile: false,
  root: fixture,
  plugins: [react()],
  define: {
    __KCODER_STUDIO_APP_VERSION__: JSON.stringify("owned-fixture"),
    __NATIVE_FILE_CASES__: process.argv[3]
      ? await readFile(process.argv[3], "utf8")
      : "null",
  },
  css: { postcss: renderer },
  resolve: {
    alias: {
      "@": resolve(renderer, "src"),
      "@extensions": resolve(renderer, "src/extensions"),
      react: resolve(renderer, "node_modules/react"),
      "react-dom": resolve(renderer, "node_modules/react-dom"),
    },
  },
  build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 5000 },
});

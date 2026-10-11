import { readFile } from "node:fs/promises";

// Follow the real CLI's static local imports. Architecture checks must inspect
// mounted modules, rather than pass by finding an unused source file elsewhere.
export async function readRunnerSources(
  entry = new URL("../bin/tui-lab.mjs", import.meta.url),
) {
  const sources = new Map();
  async function visit(url) {
    if (sources.has(url.href)) return;
    const source = await readFile(url, "utf8");
    sources.set(url.href, source);
    for (const match of source.matchAll(
      /^import\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"];?$/gm,
    )) {
      if (match[1].startsWith(".")) await visit(new URL(match[1], url));
    }
  }
  await visit(entry);
  return sources;
}

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fixturePrefix } from "./build.mjs";

/** Serve only an exact, preloaded export, never an arbitrary filesystem path. */
export async function startRecoveryFixture(run, output) {
  const assets = new Map();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json" };
  for (const name of await readdir(output, { recursive: true })) {
    try { assets.set(`${fixturePrefix}/${name}`, await readFile(resolve(output, name))); }
    catch (error) { if (error.code !== "EISDIR") throw error; }
  }
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    const key = pathname === `${fixturePrefix}/` ? `${pathname}index.html` : pathname;
    const bytes = assets.get(key);
    const status = !["GET", "HEAD"].includes(request.method) ? 405 : bytes ? 200 : 404;
    response.writeHead(status, { "Content-Type": types[extname(key)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" || status !== 200 ? undefined : bytes);
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  run.registerPort("recovery-static-fixture", server.address().port);
  run.addCleanup("close recovery static fixture", () => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}${fixturePrefix}/`;
}

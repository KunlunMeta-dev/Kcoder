import { createServer } from "node:http";

/** A local 503 sink for proving a model-independent test emitted no Provider traffic. */
export async function startProviderRequestObserver(context, label = "provider-request-observer") {
  const requests = [];
  const server = createServer((request, response) => {
    const record = {
      method: request.method || "",
      path: new URL(request.url || "/", "http://127.0.0.1").pathname,
      bytes: 0,
    };
    requests.push(record);
    request.on("data", chunk => { record.bytes += chunk.length; });
    request.on("error", () => {});
    request.resume();
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { message: "E2E observer records unexpected Provider traffic and never generates a model response" } }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  context.registerPort(label, port);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  };
  context.addCleanup(`close ${label}`, close);
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close };
}

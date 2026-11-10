import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

export async function startFixtureSite(context, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).filter(entry => entry.family === "IPv4").map(entry => entry.address);
  if (host !== "127.0.0.1" && !localAddresses.includes(host)) throw new Error("Fixture host must be an exact local IPv4 interface");
  const title = options.title || "KCoder E2E Browser Fixture";
  const marker = options.marker || "KCODER_BROWSER_FIXTURE_OK";
  const interactionState = {
    clicks: 0,
    clickTrusted: [],
    inputs: [],
    submissions: [],
    keys: [],
    focus: [],
    scrollY: 0,
  };
  const assets = new Map();
  for (const [path, asset] of Object.entries(options.assets || {})) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.') || assets.size >= 16
      || !asset || typeof asset.body !== 'string' || Buffer.byteLength(asset.body) > 1024 * 1024
      || !['text/javascript; charset=utf-8', 'text/plain; charset=utf-8'].includes(asset.contentType)) throw new Error('Invalid fixture exact asset');
    assets.set(path, { body: asset.body, contentType: asset.contentType });
  }
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const asset = assets.get(String(request.url || '/').split('?')[0]);
    if (asset && !['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    if (asset) { response.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-store' }); response.end(asset.body); return; }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/image.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20"><rect width="32" height="20" fill="#2f81f7"/></svg>');
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)} Popup</title><h1>${escapeHtml(marker)}_POPUP</h1>`);
      return;
    }
    if (requestUrl.pathname === "/interaction-state") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(interactionState));
      return;
    }
    if (requestUrl.pathname === "/interaction-event") {
      const type = requestUrl.searchParams.get("type");
      if (type === "click") {
        interactionState.clicks += 1;
        interactionState.clickTrusted.push(requestUrl.searchParams.get("trusted") === "true");
      }
      if (type === "input") interactionState.inputs.push(requestUrl.searchParams.get("value") || "");
      if (type === "submit") interactionState.submissions.push(requestUrl.searchParams.get("value") || "");
      if (type === "key") interactionState.keys.push({
        key: requestUrl.searchParams.get("key") || "",
        trusted: requestUrl.searchParams.get("trusted") === "true",
        active: requestUrl.searchParams.get("active") || "",
      });
      if (type === "focus") interactionState.focus.push(requestUrl.searchParams.get("value") || "");
      if (type === "scroll") interactionState.scrollY = Math.max(interactionState.scrollY, Number(requestUrl.searchParams.get("value")) || 0);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/interaction") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} Interactions</title>
<style>
html,body{margin:0;min-height:2200px;font:16px sans-serif;background:#fff;color:#111}
#tap{position:absolute;left:30px;top:30px;width:180px;height:70px}
#probe-form{position:absolute;left:30px;top:130px}
#probe-input{box-sizing:border-box;width:260px;height:44px;font-size:18px}
#tail{position:absolute;left:30px;top:1800px}
</style>
<button id="tap" onclick="fetch('/interaction-event?type=click&trusted=' + event.isTrusted)">REMOTE_CLICK_TARGET</button>
<form id="probe-form"><input id="probe-input" autocomplete="off"><button id="probe-submit" type="submit">SUBMIT</button></form>
<div id="tail">REMOTE_SCROLL_TARGET</div>
<script>
document.getElementById('probe-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = document.getElementById('probe-input').value;
  fetch('/interaction-event?type=submit&value=' + encodeURIComponent(value));
});
document.getElementById('probe-input').addEventListener('input', event => {
  fetch('/interaction-event?type=input&value=' + encodeURIComponent(event.target.value));
});
document.addEventListener('keydown', event => {
  fetch('/interaction-event?type=key&key=' + encodeURIComponent(event.key)
    + '&trusted=' + event.isTrusted
    + '&active=' + encodeURIComponent(document.activeElement?.id || ''));
});
document.addEventListener('focusin', () => {
  fetch('/interaction-event?type=focus&value=' + encodeURIComponent(document.activeElement?.id || ''));
});
let scrollTimer;
addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => fetch('/interaction-event?type=scroll&value=' + Math.round(scrollY)), 50);
}, { passive: true });
</script>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(marker)}</h1><button id="probe" onclick="this.textContent='CLICKED_OK'">CLICK_ME</button><a id="popup" href="/popup" target="_blank">OPEN_POPUP</a><a id="invalid-popup" href="data:text/html,DISALLOWED_POPUP" target="_blank">OPEN_INVALID_POPUP</a>`);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolveListen);
  });
  context.addCleanup("close fixture site", () => new Promise(resolveClose => server.close(resolveClose)));
  const address = server.address();
  context.registerPort("fixture-site", address.port);
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}/`,
    interactionUrl: `http://${host}:${address.port}/interaction`,
    interactionStateUrl: `http://${host}:${address.port}/interaction-state`,
    title,
    marker,
  };
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

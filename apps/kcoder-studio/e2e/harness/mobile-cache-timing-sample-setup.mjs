export async function setupCacheTimingSamplePage({
  createSamplePage,
  onPage,
  onTraffic,
  context,
  browserErrors,
  protocol,
  promptMarker,
  replacementMarker,
  clientMessageIdHashKey,
  tailMarker,
  installTelemetry,
  installResumeBridge,
}) {
  if (typeof createSamplePage !== "function" || typeof onPage !== "function" || typeof onTraffic !== "function" ||
      typeof installTelemetry !== "function" || typeof installResumeBridge !== "function") {
    throw new TypeError("Cache timing sample setup requires explicit page, resource, and bridge dependencies");
  }
  if (!(clientMessageIdHashKey instanceof Uint8Array) || clientMessageIdHashKey.byteLength !== 32) {
    throw new TypeError("Cache timing sample setup requires the per-run 32-byte client-message HMAC key");
  }

  const page = await createSamplePage();
  onPage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  page.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(context.redactText(message.text()));
  });
  await page.route("**/*", route => route.continue().catch(() => {}));
  const traffic = await installTelemetry(page, { tailMarker });
  onTraffic(traffic);
  if (!traffic || typeof traffic.dispose !== "function") {
    throw new TypeError("Cache timing sample telemetry must expose its owned dispose method");
  }
  await installResumeBridge(page, protocol, promptMarker, replacementMarker, context, clientMessageIdHashKey, traffic);
  return page;
}

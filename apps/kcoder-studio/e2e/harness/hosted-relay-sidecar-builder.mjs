import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { removeRoutesOnlyMarker }
  from "../suites/mobile/routes-only-sidecar-config.candidate.mjs";

export const RELAY_SIDECAR_INGRESS_PORT = 32552;
const ROUTE_ANCHOR = "\t@test_gateway_prefix path /g/*";

export function buildHostedSidecarCandidate(base, { marker, targetPort, gatewayId }) {
  assert.equal(typeof base, "string");
  assert.match(marker, /^kc_route_[a-f0-9]{16,64}$/);
  assert.equal(targetPort, RELAY_SIDECAR_INGRESS_PORT);
  assert.match(gatewayId, /^[a-f0-9]{32}$/);
  assert.equal(base.includes(marker), false, "the owned route marker must be absent from the original config");
  assert.equal(base.split(ROUTE_ANCHOR).length - 1, 1, "the isolated gateway route anchor must be unique");

  const block = [
    `\t# BEGIN ${marker}_routes`,
    `\t@${marker}_register path /_relay/register`,
    `\thandle @${marker}_register {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t}",
    "\t}",
    `\t@${marker}_control path /_relay/control`,
    `\thandle @${marker}_control {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_data path /_relay/data`,
    `\thandle @${marker}_data {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_gateway_0 path /g/${gatewayId} /g/${gatewayId}/*`,
    `\thandle @${marker}_gateway_0 {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t# END ${marker}_routes`,
    "",
  ].join("\n");
  assert.equal((block.match(/\bpath\s+\/_relay\//g) || []).length, 3);
  assert.equal((block.match(/\bpath\s+\/g\//g) || []).length, 1);
  assert.doesNotMatch(block, /path\s+\/g\/\*/);

  const candidate = base.replace(ROUTE_ANCHOR, `${block}${ROUTE_ANCHOR}`);
  assert.equal(removeRoutesOnlyMarker(candidate, marker), base,
    "removing only this owned route block must restore the original config bytes");
  return { candidate, block, candidateSha256: sha256(candidate), baseSha256: sha256(base), marker, gatewayId };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

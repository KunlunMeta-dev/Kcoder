import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const ROUTE_ANCHOR = "\t@test_gateway_prefix path /g/*";

export function buildRoutesOnlySidecarCandidate(base, { marker, targetPort }) {
  assert.equal(typeof base, "string");
  assert.match(marker, /^kc_route_[a-f0-9]{16,64}$/);
  assert.equal(targetPort, 32552, "this candidate is fixed to the approved temporary ingress port");
  assert.equal(base.includes(marker), false, "unique route marker must not already be in the original config");
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
    `\t# END ${marker}_routes`,
    "",
  ].join("\n");
  assert.equal((block.match(/\bpath\s+\/_relay\//g) || []).length, 3);
  assert.doesNotMatch(block, /_relay\/health|\/g\/|root \*/);

  const candidate = base.replace(ROUTE_ANCHOR, `${block}${ROUTE_ANCHOR}`);
  const restored = removeRoutesOnlyMarker(candidate, marker);
  assert.equal(sha256(restored), sha256(base), "removing only this marker must restore original config bytes");
  return { candidate, candidateSha256: sha256(candidate), baseSha256: sha256(base), marker };
}

export function removeRoutesOnlyMarker(candidate, marker) {
  const begin = `\t# BEGIN ${marker}_routes\n`;
  const end = `\t# END ${marker}_routes\n`;
  assert.equal(candidate.split(begin).length - 1, 1, "route marker begin must occur exactly once");
  assert.equal(candidate.split(end).length - 1, 1, "route marker end must occur exactly once");
  const start = candidate.indexOf(begin);
  const finish = candidate.indexOf(end);
  assert.ok(finish > start, "route marker end must follow begin");
  return `${candidate.slice(0, start)}${candidate.slice(finish + end.length)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

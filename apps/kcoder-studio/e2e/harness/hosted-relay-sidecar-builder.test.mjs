import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedSidecarCandidate, RELAY_SIDECAR_INGRESS_PORT }
  from "./hosted-relay-sidecar-builder.mjs";
import { removeRoutesOnlyMarker } from "../suites/mobile/routes-only-sidecar-config.candidate.mjs";

test("hosted Relay sidecar candidate preserves exact routes and marker restoration", () => {
  const gatewayId = "0123456789abcdef0123456789abcdef";
  const marker = "kc_route_0123456789abcdef";
  const base = "\t@test_gateway_prefix path /g/*\n\t# existing static handlers\n";
  const built = buildHostedSidecarCandidate(base, { marker, targetPort: RELAY_SIDECAR_INGRESS_PORT, gatewayId });
  const matcherRows = [...built.block.matchAll(/^\t@kc_route_0123456789abcdef_(register|control|data|gateway_0) path (.+)$/gm)];
  assert.deepEqual(matcherRows.map(row => row[1]), ["register", "control", "data", "gateway_0"]);
  assert.equal(matcherRows.length, 4, "the marker must contain exactly three Relay routes and one selected Gateway route");
  assert.equal((built.block.match(/^\thandle @kc_route_0123456789abcdef_/gm) || []).length, 4);
  assert.equal((built.block.match(new RegExp(`reverse_proxy 127\\.0\\.0\\.1:${RELAY_SIDECAR_INGRESS_PORT}`, "g")) || []).length, 4);
  assert.equal((built.block.match(/header_up Host \{http\.request\.hostport\}/g) || []).length, 4);
  assert.equal((built.block.match(/flush_interval -1/g) || []).length, 3);
  assert.match(built.block, new RegExp(`path /g/${gatewayId} /g/${gatewayId}/\\*`));
  assert.doesNotMatch(built.block, /path \/g\/\*/);
  assert.equal(removeRoutesOnlyMarker(built.candidate, marker), base, "removing the marker must restore the exact original bytes");
  assert.throws(() => buildHostedSidecarCandidate(base, { marker, targetPort: RELAY_SIDECAR_INGRESS_PORT, gatewayId: "not-a-gateway-id" }));
  assert.throws(() => buildHostedSidecarCandidate(base, { marker, targetPort: RELAY_SIDECAR_INGRESS_PORT + 1, gatewayId }));
});

import assert from "node:assert/strict";
import { buildHostedSidecarCandidate } from "./public-hosted-relay-sidecar.once.mjs";
import { removeRoutesOnlyMarker } from "../suites/mobile/routes-only-sidecar-config.candidate.mjs";

const gatewayId = "0123456789abcdef0123456789abcdef";
const marker = "kc_route_0123456789abcdef";
const base = "\t@test_gateway_prefix path /g/*\n\t# existing static handlers\n";
const built = buildHostedSidecarCandidate(base, { marker, targetPort: 32552, gatewayId });
const matcherRows = [...built.block.matchAll(/^\t@kc_route_0123456789abcdef_(register|control|data|gateway_0) path (.+)$/gm)];
assert.deepEqual(matcherRows.map(row => row[1]), ["register", "control", "data", "gateway_0"]);
assert.equal(matcherRows.length, 4, "the marker must contain exactly three Relay routes and one selected Gateway route");
assert.equal((built.block.match(/^\thandle @kc_route_0123456789abcdef_/gm) || []).length, 4);
assert.equal((built.block.match(/reverse_proxy 127\.0\.0\.1:32552/g) || []).length, 4);
assert.equal((built.block.match(/header_up Host \{http\.request\.hostport\}/g) || []).length, 4);
assert.equal((built.block.match(/flush_interval -1/g) || []).length, 3);
assert.match(built.block, new RegExp(`path /g/${gatewayId} /g/${gatewayId}/\\*`));
assert.doesNotMatch(built.block, /path \/g\/\*/);
assert.equal(removeRoutesOnlyMarker(built.candidate, marker), base, "removing the marker must restore the exact original bytes");
assert.throws(() => buildHostedSidecarCandidate(base, { marker, targetPort: 32552, gatewayId: "not-a-gateway-id" }));

process.stdout.write("PASS: four hosted routes, one selected Gateway matcher, exact marker restoration, invalid ID rejected\n");

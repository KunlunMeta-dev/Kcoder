import assert from "node:assert/strict";
import test from "node:test";
import { findHttpResponseForRouteRequest } from "./refresh-http-response-correlation.mjs";

test("only the selected post-active request response satisfies the pending hold check", () => {
  const stage = "fault:refresh-send-background-return-n30:home-resume-list-retention:delay-600:sample-01";
  const responses = [
    { routeRequestOrdinal: 1, scenario: "refresh-send-background-return-n30", stage, apiPath: "/api/servers", configuredDelayMs: 0, appliedDelayMs: 0.001 },
    { routeRequestOrdinal: 2, scenario: "refresh-send-background-return-n30", stage, apiPath: "/api/servers", configuredDelayMs: 0, appliedDelayMs: 0.001 },
  ];
  const postActiveRequest = {
    routeRequestOrdinal: 3,
    scenario: "refresh-send-background-return-n30",
    stage,
    apiPath: "/api/servers",
    startedAtEpochMs: 2546.25,
  };

  assert.equal(findHttpResponseForRouteRequest(responses, postActiveRequest), undefined);

  const heldResponse = {
    routeRequestOrdinal: 3,
    scenario: "refresh-send-background-return-n30",
    stage,
    apiPath: "/api/servers",
    configuredDelayMs: 600,
    appliedDelayMs: 600.792,
  };
  responses.push(heldResponse);
  assert.equal(findHttpResponseForRouteRequest(responses, postActiveRequest), heldResponse);
});

test("missing request identity fails closed instead of matching a same-path response", () => {
  const responses = [{ routeRequestOrdinal: 1, apiPath: "/api/servers" }];
  assert.equal(findHttpResponseForRouteRequest(responses, { apiPath: "/api/servers" }), undefined);
});

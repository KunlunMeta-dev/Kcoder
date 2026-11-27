import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { measuredTranscriptLatestDistance } from "./transcript-logical-distance.mjs";

const viewport = (scrollportTransform, scrollTop, bottomGapPx) => ({ scrollportTransform, scrollTop, bottomGapPx });

test("normal list at visual latest uses measured physical bottom gap", () => {
  assert.deepEqual(measuredTranscriptLatestDistance(viewport("none", 12167, 0)), {
    transform: "none", verticalScale: 1, orientation: "normal", pixels: 0,
  });
});

test("normal list away from latest uses physical bottom gap", () => {
  assert.equal(measuredTranscriptLatestDistance(viewport("matrix(1, 0, 0, 1, 0, 0)", 800, 351)).pixels, 351);
});

test("inverted list at visual latest ignores the large physical bottom gap", () => {
  assert.deepEqual(measuredTranscriptLatestDistance(viewport("matrix(1, 0, 0, -1, 0, 0)", 0, 12167)), {
    transform: "matrix(1, 0, 0, -1, 0, 0)", verticalScale: -1, orientation: "inverted", pixels: 0,
  });
});

test("inverted list away from latest uses measured raw top", () => {
  assert.equal(measuredTranscriptLatestDistance(viewport("matrix(1, 0, 0, -1, 0, 0)", 173, 11994)).pixels, 173);
});

test("axis-aligned 3D scale and translate reads the vertical scale", () => {
  assert.equal(measuredTranscriptLatestDistance(viewport("matrix3d(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1)", 42, 300)).pixels, 42);
});

test("missing, empty, string, and boolean scroll metrics are rejected without coercion", () => {
  const badValues = [null, undefined, "", "0", false, true];
  for (const field of ["scrollTop", "bottomGapPx"]) {
    for (const value of badValues) {
      const sample = viewport("none", 0, 0);
      sample[field] = value;
      assert.throws(() => measuredTranscriptLatestDistance(sample), /metrics must be finite numbers/);
    }
  }
});

test("unknown transform is an explicit failure, never a physical-gap fallback", () => {
  assert.throws(() => measuredTranscriptLatestDistance(viewport(null, 0, 0)), /transform was not sampled/);
  assert.throws(() => measuredTranscriptLatestDistance(viewport("rotate(180deg)", 0, 0)), /unsupported measured scrollport transform/);
});

test("rotation, shear, and perspective are rejected as unsupported direction measurements", () => {
  assert.throws(() => measuredTranscriptLatestDistance(viewport("matrix(0, 1, -1, 0, 0, 0)", 0, 0)), /only axis-aligned/);
  assert.throws(() => measuredTranscriptLatestDistance(viewport("matrix(1, 0, 1, 1, 0, 0)", 0, 0)), /only axis-aligned/);
  assert.throws(() => measuredTranscriptLatestDistance(viewport("matrix3d(1, 0, 0, 0.1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)", 0, 0)), /only axis-aligned/);
});

test("singular transform and non-finite numeric metrics are explicit failures", () => {
  assert.throws(() => measuredTranscriptLatestDistance(viewport("matrix(1, 0, 0, 0, 0, 0)", 0, 0)), /singular/);
  assert.throws(() => measuredTranscriptLatestDistance(viewport("none", Number.NaN, 0)), /metrics must be finite numbers/);
});

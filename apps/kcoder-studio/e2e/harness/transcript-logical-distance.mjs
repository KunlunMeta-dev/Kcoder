function parseVerticalScale(transform) {
  if (typeof transform !== "string") throw new Error("scrollport transform was not sampled");
  if (transform === "none") return 1;
  const matrix2d = /^matrix\(([^)]+)\)$/.exec(transform);
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (!matrix2d && !matrix3d) throw new Error(`unsupported measured scrollport transform: ${transform}`);
  const values = (matrix2d?.[1] ?? matrix3d?.[1]).split(",").map((part) => Number(part.trim()));
  const expectedLength = matrix2d ? 6 : 16;
  if (values.length !== expectedLength || values.some((value) => !Number.isFinite(value)))
    throw new Error(`invalid measured scrollport transform matrix: ${transform}`);
  if (matrix2d) {
    if (values[1] !== 0 || values[2] !== 0)
      throw new Error(`only axis-aligned scrollport scale and translate are supported: ${transform}`);
    if (values[0] === 0 || values[3] === 0)
      throw new Error(`scrollport transform matrix is singular: ${transform}`);
  } else {
    const offAxisOrPerspective = [1, 2, 3, 4, 6, 7, 8, 9, 11];
    if (offAxisOrPerspective.some((index) => values[index] !== 0) || values[15] !== 1)
      throw new Error(`only axis-aligned scrollport scale and translate are supported: ${transform}`);
    if (values[0] === 0 || values[5] === 0 || values[10] === 0)
      throw new Error(`scrollport transform matrix is singular: ${transform}`);
  }
  const verticalScale = matrix2d ? values[3] : values[5];
  if (!Number.isFinite(verticalScale) || Math.abs(verticalScale) === 0)
    throw new Error(`scrollport vertical scale is not measurable: ${transform}`);
  return verticalScale;
}

export function measuredTranscriptLatestDistance(viewport) {
  if (!viewport || typeof viewport !== "object") throw new Error("transcript viewport sample is missing");
  const verticalScale = parseVerticalScale(viewport.scrollportTransform);
  if (typeof viewport.scrollTop !== "number" || !Number.isFinite(viewport.scrollTop)
    || typeof viewport.bottomGapPx !== "number" || !Number.isFinite(viewport.bottomGapPx))
    throw new Error("transcript viewport scroll metrics must be finite numbers");
  const inverted = verticalScale < 0;
  return {
    transform: viewport.scrollportTransform,
    verticalScale,
    orientation: inverted ? "inverted" : "normal",
    pixels: inverted ? Math.abs(viewport.scrollTop) : Math.max(0, viewport.bottomGapPx),
  };
}

export function runVariantId(value = "default") {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(value)) {
    throw new TypeError("variantId must be a lowercase path-safe identifier of 1 to 64 characters");
  }
  return value;
}

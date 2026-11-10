// TypeScript and non-platform tooling use the Web fallback. Metro selects the
// explicit .native.ts adapter on Android/iOS and .web.ts in browser bundles.
export * from "./peer-transport-platform.web";

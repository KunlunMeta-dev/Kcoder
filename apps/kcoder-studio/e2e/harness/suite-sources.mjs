import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const suiteMigrations = Object.freeze(JSON.parse(readFileSync(new URL("../suite-migrations.json", import.meta.url), "utf8")));
const previousIds = new Map(Object.entries(suiteMigrations).map(([previous, current]) => [current, previous]));
const sourceMigrations = new Map(Object.entries(suiteMigrations).map(([previous, current]) => [
  posix.join("apps/kcoder-studio/e2e", previous), posix.normalize(posix.join("apps/kcoder-studio/e2e", current)),
]));

export const canonicalSuiteId = id => Object.hasOwn(suiteMigrations, id) ? suiteMigrations[id] : id;
export const canonicalTestSource = source => sourceMigrations.get(source) ?? source;
export const isIntegrationSuite = id => canonicalSuiteId(id).startsWith("../integration/");

// Historical receipts keep their recorded source; only lookup/grouping normalizes it.
export function suiteSourceAliases(sourcePath) {
  const id = relative(e2eRoot, resolve(sourcePath)).split(sep).join("/");
  const current = canonicalSuiteId(id);
  return [...new Set([current, previousIds.get(current), id].filter(Boolean))].map(value => resolve(e2eRoot, value));
}

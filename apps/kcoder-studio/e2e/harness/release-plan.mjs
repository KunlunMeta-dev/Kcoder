import { readFileSync } from 'node:fs';
import * as registry from '../suite-registry.mjs';
export const releasePlan = JSON.parse(readFileSync(new URL('../../../../scripts/release/release-gates.json', import.meta.url), 'utf8'));
export function releaseGroupSuites(name) {
  const group = releasePlan.studioGroups[name];
  if (!group) throw new Error(`Unknown release group: ${name}`);
  const source = group.registrySet ? registry[group.registrySet] : group.suites;
  if (!Array.isArray(source)) throw new Error(`Invalid release suite source: ${name}`);
  const suites = source.filter(path => !group.pathIncludes || group.pathIncludes.some(part => path.includes(part)));
  if (!suites.length || suites.some(path => !registry.registeredSuites.includes(path))) throw new Error(`Release group contains an unregistered or empty suite selection: ${name}`);
  return [...new Set(suites)];
}
export function releaseEnvironmentNames(suite) {
  return [...new Set(Object.entries(releasePlan.studioGroups).flatMap(([name, group]) => releaseGroupSuites(name).includes(suite) ? group.environment ?? [] : []))];
}

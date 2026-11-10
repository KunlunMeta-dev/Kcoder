import type { IntegrationScope, IntegrationTaskStateObservation } from './generated/contracts.integrations-core.js';
export function isTaskStateObservation(value: unknown): value is IntegrationTaskStateObservation;
export function sameTaskObservationScope(left: IntegrationScope | null | undefined, right: IntegrationScope | null | undefined): boolean;
export function foldTaskStateObservation(previous: IntegrationTaskStateObservation | null | undefined, incoming: unknown, ownerScope: IntegrationScope): {
  observation: IntegrationTaskStateObservation | null;
  changed: boolean;
  needsSnapshot: boolean;
};

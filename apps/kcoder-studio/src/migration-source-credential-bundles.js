// Offer identifiers are the complete explicit intent; they are never key material.
import { MigrationSourceBridgeError } from './migration-source-private.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = () => { throw new MigrationSourceBridgeError('private_credentials_invalid_request'); };
export function privateCredentialOfferSet(options) {
  if (!Object.hasOwn(options, 'additionalOffers')) return null;
  const additional = options.additionalOffers;
  if (!Array.isArray(additional) || additional.length < 1 || additional.length > 15
    || additional.some(value => typeof value !== 'string' || !UUID.test(value))
    || new Set(additional).size !== additional.length || additional.includes(options.offerId)) fail();
  return [options.offerId, ...additional].sort();
}
export function validPrivateCredentialOfferSet(expected, actual) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

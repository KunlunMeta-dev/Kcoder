// Pure contracts for isolated per-Gateway origins: address derivation, route
// identity, cross-origin rejection and the Caddy on-demand TLS ask decision.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  canonicalRelayAuthority,
  gatewayOriginLabel,
  isolatedGatewayAuthority,
  isolatedGatewayUrl,
} from '../src/gateway-origin.mjs';
import {
  addGatewayState,
  createGatewayRegistry,
  crossGatewayOrigin,
  normalizeAuthority,
  normalizeGatewayAddition,
  onDemandTlsAllowed,
  resolveGatewayRoute,
} from '../src/server-routing.mjs';
import { createRelayUrls } from '../deploy/config.mjs';

const gateway = (id, n) => ({ id, secret: `relay-secret-${id}-${n}`.padEnd(40, 'x'), gatewaySecret: `gateway-secret-${id}-${n}`.padEnd(40, 'y') });
const registry = (sharedHosts = ['relay.example.com']) =>
  createGatewayRegistry({ gateways: [gateway('alpha', 1), gateway('Beta', 2)], sharedHosts });
const host = (id, base = 'relay.example.com') => isolatedGatewayAuthority(base, id);

test('origin labels are stable SHA-256 prefixes of the exact case-preserved Gateway ID', () => {
  const expected = `g-${createHash('sha256').update('alpha').digest('hex').slice(0, 40)}`;
  assert.equal(gatewayOriginLabel('alpha'), expected);
  assert.notEqual(gatewayOriginLabel('Beta'), gatewayOriginLabel('beta'));
  assert.throws(() => gatewayOriginLabel('bad/id'), /Invalid Gateway ID/);
});

test('authorities normalize case and default 443, keep custom ports and reject ambiguous forms', () => {
  assert.equal(canonicalRelayAuthority('Relay.Example.COM:443'), 'relay.example.com');
  assert.equal(canonicalRelayAuthority('relay.example.com:8443'), 'relay.example.com:8443');
  for (const bad of ['relay.example.com:0443', 'relay.example.com:0', '127.0.0.1', '[::1]', 'relay', 'user@relay.example.com', 'relay.example.com.'])
    assert.throws(() => canonicalRelayAuthority(bad), /Invalid Relay public authority/, bad);
  assert.equal(normalizeAuthority('RELAY.example.com:443'), 'relay.example.com');
  assert.equal(normalizeAuthority('relay.example.com:08443'), null);
  assert.throws(() => createGatewayRegistry({ gateways: [gateway('a', 1)], sharedHosts: ['relay.example.com', 'relay.example.com:443'] }), /Duplicate shared host/);
});

test('isolated URLs keep the /g/<id> mount and refuse another Gateway origin', () => {
  const alpha = isolatedGatewayUrl('https://RELAY.example.com:443/', 'alpha');
  assert.equal(alpha.href, `https://${gatewayOriginLabel('alpha')}.relay.example.com/g/alpha/`);
  assert.equal(isolatedGatewayUrl(alpha, 'alpha').href, alpha.href, 'an own origin is idempotent');
  assert.equal(isolatedGatewayUrl('https://relay.example.com:8443', 'alpha').host, `${gatewayOriginLabel('alpha')}.relay.example.com:8443`);
  assert.throws(() => isolatedGatewayUrl(alpha, 'Beta'), /different Gateway origin/);
  assert.throws(() => isolatedGatewayUrl('http://relay.example.com', 'alpha'), /Invalid Relay public URL/);
});

test('createRelayUrls isolates path mode, leaves legacy URLs and keeps health on the shared root', () => {
  const urls = createRelayUrls({ publicUrl: 'https://relay.example.com', gatewayId: 'alpha', routeMode: 'path' });
  assert.equal(urls.gatewayBase.host, host('alpha'));
  assert.equal(urls.gatewayEndpoint('/rpc').href, `https://${host('alpha')}/g/alpha/rpc`);
  assert.equal(new URL('/_relay/health', urls.publicRoot).host, 'relay.example.com');
  const own = createRelayUrls({ publicUrl: `https://${host('alpha')}`, gatewayId: 'alpha', routeMode: 'path' });
  assert.equal(own.publicRoot.host, 'relay.example.com', 'a Gateway origin is never the control root');
  assert.equal(createRelayUrls({ publicUrl: 'https://relay.example.com' }).gatewayBase.href, 'https://relay.example.com/');
});

test('routes bind the host label and path ID to the same Gateway', () => {
  const reg = registry();
  const ok = resolveGatewayRoute(reg, `${host('alpha').toUpperCase()}:443`, '/g/alpha/api/x?q=1');
  assert.equal(ok.gateway.id, 'alpha');
  assert.equal(ok.isolated, true);
  assert.equal(ok.authority, host('alpha'), 'canonical authority is forwarded to the Gateway');
  assert.equal(ok.target, '/api/x?q=1');
  assert.equal(resolveGatewayRoute(reg, host('alpha'), '/g/Beta/api/x').error, 'gateway-mismatch');
  assert.equal(resolveGatewayRoute(reg, host('Beta'), '/g/alpha/').error, 'gateway-mismatch');
  assert.equal(resolveGatewayRoute(reg, host('alpha'), '/').error, 'shared-path');
  assert.equal(resolveGatewayRoute(reg, host('unknown'), '/g/unknown/').error, 'unknown-host');
  assert.equal(resolveGatewayRoute(reg, host('alpha', 'other.example.com'), '/g/alpha/').error, 'unknown-host');
  assert.equal(resolveGatewayRoute(reg, `${gatewayOriginLabel('alpha')}.${host('alpha')}`, '/g/alpha/').error, 'unknown-host');
  assert.equal(resolveGatewayRoute(reg, `x.${host('alpha')}`, '/g/alpha/').error, 'unknown-host');
  for (const target of ['/g/alpha/../Beta/api', '/g/alpha/%2e%2E/Beta/', '/g/alpha/./x', '/g/alpha\\..\\Beta'])
    assert.equal(resolveGatewayRoute(reg, host('alpha'), target).error, 'invalid', target);
  const shared = resolveGatewayRoute(reg, 'relay.example.com:443', '/g/Beta/mobile/');
  assert.equal(shared.isolated, false);
  assert.equal(shared.canonicalAuthority, host('Beta'), 'shared navigation targets the path Gateway origin');
  const custom = registry(['relay.example.com:8443']);
  assert.equal(resolveGatewayRoute(custom, host('alpha', 'relay.example.com:8443'), '/g/alpha/').gateway.id, 'alpha');
  assert.equal(resolveGatewayRoute(custom, host('alpha'), '/g/alpha/').error, 'unknown-host', 'default and custom ports are distinct origins');
  assert.throws(() => createGatewayRegistry({ gateways: [gateway('a', 1)], sharedHosts: [host('alpha')] }), /cannot be a Gateway origin/);
});

test('Origins from the shared root or another Gateway origin are cross-Gateway', () => {
  const reg = registry();
  const route = resolveGatewayRoute(reg, host('alpha'), '/g/alpha/rpc');
  assert.equal(crossGatewayOrigin(reg, route, undefined), false);
  assert.equal(crossGatewayOrigin(reg, route, `https://${host('alpha')}`), false);
  assert.equal(crossGatewayOrigin(reg, route, `https://${host('Beta')}`), true);
  assert.equal(crossGatewayOrigin(reg, route, `https://${host('unregistered')}`), true);
  assert.equal(crossGatewayOrigin(reg, route, 'https://relay.example.com'), true);
  assert.equal(crossGatewayOrigin(reg, route, 'https://unrelated.example'), false, 'unrelated origins stay with the Gateway allowlist');
});

test('on-demand TLS ask allows only exact active Gateway names and follows registration and restart', () => {
  const reg = registry(['relay.example.com:8443']);
  const name = id => isolatedGatewayAuthority('relay.example.com', id);
  assert.equal(onDemandTlsAllowed(reg, name('alpha')), true);
  assert.equal(onDemandTlsAllowed(reg, name('Beta')), true);
  for (const denied of [name('gamma'), name('alpha').toUpperCase(), `${name('alpha')}.`, `${name('alpha')}:8443`,
    `${name('alpha')}:443`, `x.${name('alpha')}`, name('alpha').replace('relay.example.com', 'evil.example.com'),
    'relay.example.com', `g-${'0'.repeat(40)}.relay.example.com`, '', undefined])
    assert.equal(onDemandTlsAllowed(reg, denied), false, String(denied));
  const added = normalizeGatewayAddition(reg, gateway('gamma', 3));
  assert.equal(onDemandTlsAllowed(reg, name('gamma')), false, 'validation alone does not authorize');
  addGatewayState(reg, added);
  assert.equal(onDemandTlsAllowed(reg, name('gamma')), true, 'committed registration is authorized');
  assert.throws(() => addGatewayState(reg, added), /Duplicate Gateway identity/);
  const restarted = createGatewayRegistry({ gateways: [gateway('alpha', 1)], sharedHosts: ['relay.example.com:8443'] });
  assert.equal(onDemandTlsAllowed(restarted, name('Beta')), false, 'a revoked Gateway is denied after reload');
  assert.equal(onDemandTlsAllowed(createGatewayRegistry({ secret: 'legacy-secret'.padEnd(40, 'z'), device: 'alpha' }), name('alpha')), false);
});

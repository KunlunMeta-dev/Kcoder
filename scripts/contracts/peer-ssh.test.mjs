import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isContract } from '../../apps/kcoder-studio/shared/generated/validator.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.peer-ssh.json', import.meta.url)));
const example = name => structuredClone(fixtures[name].valid[0].value);

test('SSH peer DTO validation checks shape and rejects fields claiming a grant', () => {
  for (const name of ['PeerSshEnrollmentV1', 'PeerSshChallengeOfferV1', 'PeerSshChallengeClaimsV1', 'PeerSshNativeProofV1', 'PeerSshGatewayProofV1']) {
    const value = example(name);
    assert.equal(isContract(name, value), true, name);
    for (const field of ['authorized', 'allow', 'deviceBearer', 'retentionProof', 'privateParent'])
      assert.equal(isContract(name, { ...value, [field]: true }), false, `${name}/${field}`);
  }
});

test('SSH peer generated scalar bounds agree with Rust Unicode and safe generations', () => {
  const pins = example('PeerSshEnrollmentV1');
  for (const value of ['', 'profile\n', 'profile\r', 'profile\u0085', 'x'.repeat(257), '\ud800']) {
    const changed = structuredClone(pins); changed.native.profileIdentity = value;
    assert.equal(isContract('PeerSshEnrollmentV1', changed), false, JSON.stringify(value));
  }
  for (const value of ['中'.repeat(256), '😀'.repeat(256)]) {
    const changed = structuredClone(pins); changed.native.profileIdentity = value;
    assert.equal(isContract('PeerSshEnrollmentV1', changed), true);
  }
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(isContract('PeerSshEnrollmentV1', { ...pins, generation }), false);
  assert.equal(isContract('PeerSshEnrollmentV1', { ...pins, generation: Number.MAX_SAFE_INTEGER }), true);
});

test('SSH peer proof purposes and key/signature lengths stay distinct from other protocols', () => {
  const pins = example('PeerSshEnrollmentV1');
  for (const length of [0, 31, 33]) {
    const changed = structuredClone(pins); changed.gateway.publicKey = Array(length).fill(0);
    assert.equal(isContract('PeerSshEnrollmentV1', changed), false);
  }
  for (const purpose of ['kcoder.gateway.connection-proof.v1', 'kcoder.peer-source.presence.v1', 'kcoder.peer-message.route.v1']) {
    const changed = example('PeerSshGatewayProofV1'); changed.native.claims.purpose = purpose;
    assert.equal(isContract('PeerSshGatewayProofV1', changed), false);
  }
  for (const length of [0, 63, 65]) {
    const changed = example('PeerSshGatewayProofV1'); changed.signature = Array(length).fill(0);
    assert.equal(isContract('PeerSshGatewayProofV1', changed), false);
  }
});
